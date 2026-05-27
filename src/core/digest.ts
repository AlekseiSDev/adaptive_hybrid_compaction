import type { FeatureFlags } from './featureFlags.js'
import type { LLMCaller } from './llm.js'
import type { AtomicGroup, ContentPart } from './types.js'

export type ToolSchema = {
  // Calibrated-important field names projected by schema-aware strategy.
  importantFields: readonly string[]
}

export type DigestDeps = {
  flags: FeatureFlags
  llmCaller?: LLMCaller
  toolSchema?: ToolSchema
}

export type DigestStrategy =
  | 'content_aware'
  | 'schema_aware'
  | 'llm_summarize'
  | 'rule_based'
  | 'empty_sentinel'

const RULE_BASED_HEAD_CHARS = 300
const RULE_BASED_TAIL_CHARS = 300
const TRUNCATION_MARKER = '[…truncated…]'
const ARRAY_PROJECTION_LIMIT = 5
const LLM_SUMMARIZE_BUDGET = 80
const LLM_SUMMARIZE_PROMPT =
  'Summarize this tool output in 80 tokens, preserving any IDs/scores/keys that could be referenced later.'

// Content-aware projection budgets (per-tool, in chars). Sized so the
// total summary is bounded to ~1-2K chars per pointer; with ≤10 pointers
// a typical trajectory keeps Tier-2 well under TIER3_TOKEN_BUDGET.
const WEB_SEARCH_TOP_N = 8
const WEB_SEARCH_SNIPPET_HEAD = 300
const VISIT_WEBPAGE_HEAD = 800
const VISIT_WEBPAGE_TAIL = 400
const PYTHON_EXEC_STDOUT_HEAD = 1000
const PYTHON_EXEC_STDERR_HEAD = 600
const TEXT_EDITOR_HEAD = 600
const DESCRIBE_IMAGE_FULL_THRESHOLD = 2000
const DESCRIBE_IMAGE_HEAD = 1000
const DESCRIBE_IMAGE_TAIL = 500

function extractToolResultOutput(group: AtomicGroup): unknown {
  const part = group.tool_result.content.find((p): p is Extract<ContentPart, { type: 'tool_result' }> =>
    p.type === 'tool_result',
  )
  return part?.output
}

function extractToolName(group: AtomicGroup): string | undefined {
  const part = group.tool_use.content.find((p): p is Extract<ContentPart, { type: 'tool_use' }> =>
    p.type === 'tool_use',
  )
  return part?.name
}

function extractToolInput(group: AtomicGroup): unknown {
  const part = group.tool_use.content.find((p): p is Extract<ContentPart, { type: 'tool_use' }> =>
    p.type === 'tool_use',
  )
  return part?.input
}

function isEmptyOutput(output: unknown): boolean {
  if (output === null || output === undefined) return true
  if (typeof output === 'string' && output.length === 0) return true
  if (Array.isArray(output) && output.length === 0) return true
  if (typeof output === 'object' && Object.keys(output).length === 0) {
    return true
  }
  return false
}

// Empty/undefined outputs are caught upstream by isEmptyOutput; safe to trust TS's `string` return.
function safeStringify(output: unknown): string {
  return JSON.stringify(output)
}

function ruleBasedFallback(output: unknown): string {
  const serialized = safeStringify(output)
  if (serialized.length <= RULE_BASED_HEAD_CHARS + RULE_BASED_TAIL_CHARS + TRUNCATION_MARKER.length) {
    return serialized
  }
  const head = serialized.slice(0, RULE_BASED_HEAD_CHARS)
  const tail = serialized.slice(-RULE_BASED_TAIL_CHARS)
  return `${head}${TRUNCATION_MARKER}${tail}`
}

function schemaProjection(output: unknown, schema: ToolSchema): string {
  if (output === null || typeof output !== 'object') {
    return ruleBasedFallback(output)
  }
  const projected: Record<string, unknown> = {}
  const source = output as Record<string, unknown>
  for (const field of schema.importantFields) {
    if (!(field in source)) continue
    const value = source[field]
    if (Array.isArray(value) && value.length > ARRAY_PROJECTION_LIMIT) {
      const truncated: unknown[] = (value as unknown[]).slice(0, ARRAY_PROJECTION_LIMIT)
      projected[field] = [...truncated, '…']
    } else {
      projected[field] = value
    }
  }
  return JSON.stringify(projected)
}

async function llmSummarize(output: unknown, caller: LLMCaller): Promise<string> {
  const payload = safeStringify(output)
  const response = await caller({
    messages: [
      { role: 'system', content: LLM_SUMMARIZE_PROMPT },
      { role: 'user', content: payload },
    ],
    maxOutputTokens: LLM_SUMMARIZE_BUDGET,
  })
  return response.text
}

// --- Content-aware per-tool projectors (K-tail-3 2026-05-26) ---
//
// Each projector knows the published return-type shape of a specific GAIA
// tool and projects it into a compact JSON-stringified summary that preserves
// the high-signal fields (URLs, exact stdout, file paths) while dropping the
// noise. Sized so a typical web_search dump (~30KB) compresses to ~1KB
// containing the top URLs + headings + first 300 chars of each snippet —
// usually enough for the actor to decide the answer without calling
// recall_tool_full.

function headTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + TRUNCATION_MARKER.length) return s
  return `${s.slice(0, head)}${TRUNCATION_MARKER}${s.slice(-tail)}`
}

function projectWebSearch(output: unknown, input: unknown): string {
  if (!Array.isArray(output)) return ruleBasedFallback(output)
  const top = output.slice(0, WEB_SEARCH_TOP_N).map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>
    return {
      title: typeof rec['title'] === 'string' ? rec['title'] : '',
      url: typeof rec['url'] === 'string' ? rec['url'] : '',
      snippet:
        typeof rec['snippet'] === 'string'
          ? (rec['snippet']).slice(0, WEB_SEARCH_SNIPPET_HEAD)
          : '',
    }
  })
  const query =
    input !== null && typeof input === 'object' && typeof (input as Record<string, unknown>)['query'] === 'string'
      ? ((input as Record<string, unknown>)['query'] as string)
      : ''
  return JSON.stringify({ query, n_results: output.length, top })
}

function projectVisitWebpage(output: unknown): string {
  if (output === null || typeof output !== 'object') return ruleBasedFallback(output)
  const rec = output as Record<string, unknown>
  const title = typeof rec['title'] === 'string' ? (rec['title']) : ''
  const text = typeof rec['text_content'] === 'string' ? (rec['text_content']) : ''
  return JSON.stringify({
    title,
    text_excerpt: headTail(text, VISIT_WEBPAGE_HEAD, VISIT_WEBPAGE_TAIL),
    full_length_chars: text.length,
  })
}

function projectPythonExec(output: unknown): string {
  if (output === null || typeof output !== 'object') return ruleBasedFallback(output)
  const rec = output as Record<string, unknown>
  const stdout = typeof rec['stdout'] === 'string' ? (rec['stdout']) : ''
  const stderr = typeof rec['stderr'] === 'string' ? (rec['stderr']) : ''
  const exit = typeof rec['exit_code'] === 'number' ? (rec['exit_code']) : null
  return JSON.stringify({
    stdout_head: stdout.slice(0, PYTHON_EXEC_STDOUT_HEAD),
    stdout_truncated: stdout.length > PYTHON_EXEC_STDOUT_HEAD,
    stderr: stderr.slice(0, PYTHON_EXEC_STDERR_HEAD),
    exit_code: exit,
  })
}

function projectTextEditor(output: unknown, input: unknown): string {
  if (output === null || typeof output !== 'object') return ruleBasedFallback(output)
  const rec = output as Record<string, unknown>
  const content = typeof rec['content'] === 'string' ? (rec['content']) : ''
  const origSize =
    typeof rec['original_size'] === 'number' ? (rec['original_size']) : content.length
  const path =
    input !== null && typeof input === 'object' && typeof (input as Record<string, unknown>)['path'] === 'string'
      ? ((input as Record<string, unknown>)['path'] as string)
      : ''
  return JSON.stringify({
    path,
    total_size: origSize,
    content_head: content.slice(0, TEXT_EDITOR_HEAD),
    truncated: content.length > TEXT_EDITOR_HEAD,
  })
}

function projectDescribeImage(output: unknown): string {
  if (output === null || typeof output !== 'object') return ruleBasedFallback(output)
  const rec = output as Record<string, unknown>
  const description = typeof rec['description'] === 'string' ? (rec['description']) : ''
  if (description.length <= DESCRIBE_IMAGE_FULL_THRESHOLD) {
    return JSON.stringify({ description })
  }
  return JSON.stringify({
    description: headTail(description, DESCRIBE_IMAGE_HEAD, DESCRIBE_IMAGE_TAIL),
  })
}

function contentAwareProjection(group: AtomicGroup): string | null {
  const output = extractToolResultOutput(group)
  const input = extractToolInput(group)
  const name = extractToolName(group)
  switch (name) {
    case 'web_search':
      return projectWebSearch(output, input)
    case 'visit_webpage':
      return projectVisitWebpage(output)
    case 'python_exec':
      return projectPythonExec(output)
    case 'text_editor':
      return projectTextEditor(output, input)
    case 'describe_image':
      return projectDescribeImage(output)
    default:
      return null
  }
}

export async function generateDigest(group: AtomicGroup, deps: DigestDeps): Promise<string> {
  const output = extractToolResultOutput(group)
  if (isEmptyOutput(output)) return '<empty>'
  if (deps.flags.CONTENT_AWARE_DIGEST) {
    const projected = contentAwareProjection(group)
    if (projected !== null) return projected
    // Unknown tool — fall through to existing strategies.
  }
  if (deps.flags.SCHEMA_AWARE_DIGEST && deps.toolSchema !== undefined) {
    return schemaProjection(output, deps.toolSchema)
  }
  if (deps.llmCaller !== undefined) {
    return llmSummarize(output, deps.llmCaller)
  }
  return ruleBasedFallback(output)
}
