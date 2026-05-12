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

export type DigestStrategy = 'schema_aware' | 'llm_summarize' | 'rule_based' | 'empty_sentinel'

const RULE_BASED_HEAD_CHARS = 300
const RULE_BASED_TAIL_CHARS = 300
const TRUNCATION_MARKER = '[…truncated…]'
const ARRAY_PROJECTION_LIMIT = 5
const LLM_SUMMARIZE_BUDGET = 80
const LLM_SUMMARIZE_PROMPT =
  'Summarize this tool output in 80 tokens, preserving any IDs/scores/keys that could be referenced later.'

function extractToolResultOutput(group: AtomicGroup): unknown {
  const part = group.tool_result.content.find((p): p is Extract<ContentPart, { type: 'tool_result' }> =>
    p.type === 'tool_result',
  )
  return part?.output
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

export async function generateDigest(group: AtomicGroup, deps: DigestDeps): Promise<string> {
  const output = extractToolResultOutput(group)
  if (isEmptyOutput(output)) return '<empty>'
  if (deps.flags.SCHEMA_AWARE_DIGEST && deps.toolSchema !== undefined) {
    return schemaProjection(output, deps.toolSchema)
  }
  if (deps.llmCaller !== undefined) {
    return llmSummarize(output, deps.llmCaller)
  }
  return ruleBasedFallback(output)
}
