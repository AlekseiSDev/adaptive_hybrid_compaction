// AssistantTraj-v2 tool runtime (Track J).
// Source of truth: docs/design/J_at_tools.md §3, §4.
//
// Replay-default (deterministic, CI-safe). Live mode (network calls) gated
// behind AT_TOOL_MODE=live env var; CI guard throws to prevent silent live
// runs in eval sweeps.

import { z } from 'zod'
import type { ToolHandle, ToolHandleContentPart } from '../types.js'
import {
  AT_TOOL_NAMES,
  type AtToolName,
  type ToolFixture,
  type ToolFixtureFile,
  type ToolFixtureInputMatch,
} from './assistant-traj.tool-fixtures.schema.js'

export { AT_TOOL_NAMES }
export type { AtToolName }

// ---- Mode resolution ------------------------------------------------------

export type ToolMode = 'replay' | 'live'

export function resolveToolMode(): ToolMode {
  const mode = process.env['AT_TOOL_MODE'] === 'live' ? 'live' : 'replay'
  if (mode === 'live' && process.env['CI'] === 'true') {
    throw new Error(
      'AT_TOOL_MODE=live is forbidden in CI — eval determinism would break (see docs/design/J_at_tools.md §10.5)',
    )
  }
  return mode
}

// ---- Replay dispatcher ----------------------------------------------------

export class ToolReplayMissError extends Error {
  readonly task_id: string
  readonly tool_name: AtToolName
  readonly attempted_input: unknown
  readonly callIndex: number

  constructor(args: {
    task_id: string
    tool_name: AtToolName
    attempted_input: unknown
    callIndex: number
  }) {
    super(
      `tool_replay_miss: task=${args.task_id} tool=${args.tool_name} callIndex=${String(args.callIndex)} input=${JSON.stringify(args.attempted_input)}`,
    )
    this.name = 'ToolReplayMissError'
    this.task_id = args.task_id
    this.tool_name = args.tool_name
    this.attempted_input = args.attempted_input
    this.callIndex = args.callIndex
  }
}

export type ToolResultPayload = {
  content: ToolHandleContentPart[]
  isError?: boolean
}

export class ReplayDispatcher {
  private readonly task_id: string
  private readonly fixtures: readonly ToolFixture[]
  // Per-tool call counter — same tool, separate ordering. Independent across
  // tool names so e.g. google_search[0] and web_fetch[0] don't share an index.
  private readonly callIndex = new Map<AtToolName, number>()
  // Per-tool fixture-consumption tracker for 'first' matcher — tracks which
  // per-tool fixture slot the next 'first' call should target.
  private readonly firstSlot = new Map<AtToolName, number>()

  constructor(file: ToolFixtureFile) {
    this.task_id = file.task_id
    this.fixtures = file.fixtures
  }

  async dispatch(tool_name: AtToolName, input: unknown): Promise<ToolResultPayload> {
    const idx = this.callIndex.get(tool_name) ?? 0
    const matched = this.findMatch(tool_name, input)
    if (matched === null) {
      throw new ToolReplayMissError({
        task_id: this.task_id,
        tool_name,
        attempted_input: input,
        callIndex: idx,
      })
    }
    this.callIndex.set(tool_name, idx + 1)
    if (matched.matcher === 'first') {
      this.firstSlot.set(tool_name, (this.firstSlot.get(tool_name) ?? 0) + 1)
    }
    const result: ToolResultPayload = { content: matched.fixture.output_parts }
    if (matched.fixture.is_error === true) {
      result.isError = true
    }
    return Promise.resolve(result)
  }

  private findMatch(
    tool_name: AtToolName,
    input: unknown,
  ): { fixture: ToolFixture; matcher: 'first' | 'args_exact' | 'args_subset' } | null {
    // Explicit args_exact / args_subset matchers checked first — they're
    // intentional, override 'first' ordering.
    for (const f of this.fixtures) {
      if (f.tool_name !== tool_name) continue
      const m = f.input_match
      if (!m || m.kind === 'first') continue
      if (m.kind === 'args_exact' && deepEqual(input, m.args)) {
        return { fixture: f, matcher: 'args_exact' }
      }
      if (m.kind === 'args_subset' && isSubset(m.args, input)) {
        return { fixture: f, matcher: 'args_subset' }
      }
    }
    // Fall through to 'first' (default): take next unconsumed per-tool fixture.
    const slot = this.firstSlot.get(tool_name) ?? 0
    let seen = 0
    for (const f of this.fixtures) {
      if (f.tool_name !== tool_name) continue
      const matcher: ToolFixtureInputMatch = f.input_match ?? { kind: 'first' }
      if (matcher.kind !== 'first') {
        // already checked above and didn't match — skip from 'first' pool
        continue
      }
      if (seen === slot) {
        return { fixture: f, matcher: 'first' }
      }
      seen += 1
    }
    return null
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).sort()
  const bk = Object.keys(bo).sort()
  if (ak.length !== bk.length) return false
  return ak.every((k, i) => k === bk[i] && deepEqual(ao[k], bo[k]))
}

function isSubset(expected: Record<string, unknown>, actual: unknown): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const ao = actual as Record<string, unknown>
  for (const k of Object.keys(expected)) {
    if (!(k in ao)) return false
    if (!deepEqual(expected[k], ao[k])) return false
  }
  return true
}

// ---- Tool input schemas (J §3.1) ------------------------------------------
// Authored as Zod for type-safety on author/test side; AI SDK v6 providers
// will serialize to JSON Schema at provider boundary.

export const imageGenInput = z.object({
  prompt: z.string().min(1).max(2000),
  n: z.number().int().min(1).max(4).optional(),
  size: z
    .enum(['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'])
    .optional(),
})

export const googleSearchInput = z.object({
  q: z.string().min(1).max(500),
  n: z.number().int().min(1).max(10).optional(),
  lang: z.string().length(2).optional(),
  country: z.string().length(2).optional(),
})

export const webFetchInput = z.object({
  url: z.url(),
  max_chars: z.number().int().min(500).max(50000).optional(),
})

export const codeInterpreterInput = z.object({
  code: z.string().min(1).max(20000),
  timeout_ms: z.number().int().min(100).max(30000).optional(),
})

export const TOOL_INPUT_SCHEMAS = {
  image_gen: imageGenInput,
  google_search: googleSearchInput,
  web_fetch: webFetchInput,
  code_interpreter: codeInterpreterInput,
} as const satisfies Record<AtToolName, z.ZodType>

export const TOOL_DESCRIPTIONS: Record<AtToolName, string> = {
  image_gen: 'Generate an image from a text prompt. Returns image URL plus short caption.',
  google_search: 'Web search via Google. Returns top-N results as title+snippet+URL list.',
  web_fetch: 'Fetch a web page and return cleaned main content as Markdown. HTML only.',
  code_interpreter: 'Execute Python 3 code in a sandbox. Returns stdout, stderr, and exit code.',
}

// ---- ToolHandle factories (replay-bound) ----------------------------------

export function buildReplayTools(
  dispatcher: ReplayDispatcher,
): Record<AtToolName, ToolHandle> {
  const out = {} as Record<AtToolName, ToolHandle>
  for (const name of AT_TOOL_NAMES) {
    out[name] = {
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_SCHEMAS[name],
      execute: async (input: unknown) => dispatcher.dispatch(name, input),
    }
  }
  return out
}

// Empty-dispatcher fallback for tasks declaring tools_available but with no
// sidecar (legacy / future-noop). Every call raises ToolReplayMissError —
// surfaces config gaps immediately rather than silently passing.
export function buildEmptyReplayDispatcher(task_id: string): ReplayDispatcher {
  return new ReplayDispatcher({ task_id, fixtures: [] })
}
