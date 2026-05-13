import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaCompactionBlock,
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import type { Model as AnthropicModel } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../../core/prompts.js'
import { composeTurnRecord, mapAnthropicUsage } from '../telemetry.js'
import type {
  Baseline,
  CompactionEvent,
  Instrumentation,
  Message,
  TurnRecord,
} from '../types.js'

// AnthropicNativeBaseline — server-side `compact_20260112` strategy on
// `client.beta.messages`. Per docs/investigations/anthropic-compact-shape.md
// the round-trip mechanism is BetaCompactionBlock echoed in subsequent
// requests' `messages[]`, NOT session id as design/C_baselines.md §3
// originally speculated.
//
// Vendor exception per system_design.md §6.1: this is the only non-Gemini
// baseline because the compact_20260112 feature exists only on Anthropic.

// Exactly one of `apiKey` / `authToken` must be supplied (runtime-checked in
// the factory). `apiKey` bills against console.anthropic.com credits;
// `authToken` (long-lived OAuth via `claude setup-token`) bills against the
// Pro/Max subscription — same SDK, same compact_20260112 semantics.
// See docs/investigations/anthropic-pro-max-oauth.md.
export type AnthropicCompactDeps = {
  apiKey?: string
  authToken?: string
  /**
   * Override the SDK base URL. Used to route through an Anthropic-protocol
   * proxy (e.g. local LiteLLM on http://localhost:4400). When set, the proxy
   * is responsible for upstream auth — the `apiKey`/`authToken` here is the
   * proxy's own token. Defaults to Anthropic direct.
   */
  baseURL?: string
  /**
   * Model name. Type is widened from `AnthropicModel` to `string` so proxy-
   * specific aliases (e.g. LiteLLM's `claude-sonnet-4.6` dot-form) can be
   * passed without losing the canonical Anthropic IDs autocompletion.
   */
  model?: AnthropicModel | (string & Record<never, never>)
  /**
   * Trigger threshold (input tokens) for compaction. Default 100000 (matches
   * Anthropic SDK's `DEFAULT_TOKEN_THRESHOLD`). API enforces a hard minimum
   * of 50000; values below it are 400-rejected. Real long-trajectory sweeps
   * may keep the default; compaction-fire tests pre-load ≥100k tokens of
   * history before stepping.
   */
  triggerInputTokens?: number
  /** Optional summarization instructions to influence compaction quality. */
  instructions?: string
  /** Max tokens per response. */
  maxTokens?: number
  /**
   * System prompt forwarded to Anthropic's top-level `system:` field. Default:
   * `DEFAULT_AGENT_SYSTEM_PROMPT` from core (shared with all other baselines
   * for fair-comparison invariant). Pass empty string to disable.
   */
  systemPrompt?: string
}

const DEFAULT_MODEL: NonNullable<AnthropicCompactDeps['model']> = 'claude-sonnet-4-6'
const DEFAULT_TRIGGER_INPUT_TOKENS = 100_000
const DEFAULT_MAX_TOKENS = 1024

type AnthropicScratch = {
  model: NonNullable<AnthropicCompactDeps['model']>
  compaction_blocks: BetaCompactionBlock[]
}

function extractTextContent(msg: Message): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

function coreMessageToBetaParam(msg: Message): BetaMessageParam | null {
  if (msg.role === 'tool') return null
  if (msg.role === 'system') return null // system goes via top-level `system` param
  const text = extractTextContent(msg)
  if (text.length === 0) return null
  return {
    role: msg.role,
    content: [{ type: 'text', text } satisfies BetaTextBlockParam],
  }
}

function approximateBytes(blocks: readonly BetaMessageParam[]): number {
  let total = 0
  for (const m of blocks) {
    if (typeof m.content === 'string') {
      total += m.content.length
      continue
    }
    for (const block of m.content) {
      if (block.type === 'text') total += block.text.length
    }
  }
  return total
}

function extractCompactionBlocks(content: BetaContentBlock[]): BetaCompactionBlock[] {
  return content.filter((b): b is BetaCompactionBlock => b.type === 'compaction')
}

function extractAssistantText(content: BetaContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

export function anthropicCompactBaseline(deps: AnthropicCompactDeps): Baseline {
  // Runtime validation: exactly one credential must be supplied. Type system
  // can't enforce mutual exclusion without making the deps inconvenient for
  // env-derived call sites (see runner.ts § makeAnthropicCompactRunner).
  const apiKey = deps.apiKey
  const authToken = deps.authToken
  const hasApiKey = apiKey !== undefined && apiKey.length > 0
  const hasAuthToken = authToken !== undefined && authToken.length > 0
  if (!hasApiKey && !hasAuthToken) {
    throw new Error(
      'anthropicCompactBaseline: must supply apiKey or authToken (see docs/investigations/anthropic-pro-max-oauth.md)',
    )
  }
  if (hasApiKey && hasAuthToken) {
    throw new Error(
      'anthropicCompactBaseline: pass only one of apiKey or authToken — both would create ambiguous billing',
    )
  }
  const baseURLOpt = deps.baseURL !== undefined ? { baseURL: deps.baseURL } : {}
  const client = hasAuthToken
    ? new Anthropic({ authToken, ...baseURLOpt })
    : new Anthropic({ apiKey, ...baseURLOpt })
  const model = deps.model ?? DEFAULT_MODEL
  const trigger = deps.triggerInputTokens ?? DEFAULT_TRIGGER_INPUT_TOKENS
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS

  return {
    name: 'anthropic_compact',
    prepare: (task) => {
      const scratch: AnthropicScratch = {
        model,
        compaction_blocks: [],
      }
      return {
        task_id: task.id,
        history: [],
        scratch: { ...scratch },
      }
    },

    step: async (state, userMsg, opts) => {
      const scratchUnknown = state.scratch
      if (!scratchUnknown) {
        throw new Error('AnthropicCompactBaseline.step: missing scratch (call prepare first)')
      }
      const scratch = scratchUnknown as unknown as AnthropicScratch
      const turn_index = state.history.filter((m) => m.role === 'user').length

      // Outgoing messages = prior compaction blocks (echoed for round-trip) +
      // history + new user msg. Compaction blocks ride as a synthetic user
      // message at the front — Anthropic recognizes the block type.
      const historyBeta: BetaMessageParam[] = []
      if (scratch.compaction_blocks.length > 0) {
        historyBeta.push({
          role: 'user',
          content: scratch.compaction_blocks.map((b) => ({
            type: 'compaction' as const,
            content: b.content,
            encrypted_content: b.encrypted_content,
          })),
        })
      }
      for (const m of state.history) {
        const beta = coreMessageToBetaParam(m)
        if (beta) historyBeta.push(beta)
      }
      const userBeta = coreMessageToBetaParam(userMsg)
      if (userBeta) historyBeta.push(userBeta)

      const beforeBytes = approximateBytes(historyBeta)

      const start = Date.now()
      // `betas: ['compact-2026-01-12']` is required — without it the API
      // rejects the `context_management` field as "Extra inputs are not
      // permitted" (the parameter exists only behind this beta gate). The
      // beta name dashes, not the strategy's `compact_20260112` underscore
      // form. Source: https://platform.claude.com/docs/en/build-with-claude/
      // compaction.
      const systemPrompt = deps.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT
      const response: BetaMessage = await client.beta.messages.create({
        model: scratch.model,
        max_tokens: maxTokens,
        messages: historyBeta,
        ...(systemPrompt.length > 0 ? { system: systemPrompt } : {}),
        betas: ['compact-2026-01-12'],
        context_management: {
          edits: [
            {
              type: 'compact_20260112' as const,
              trigger: { type: 'input_tokens' as const, value: trigger },
              ...(deps.instructions !== undefined ? { instructions: deps.instructions } : {}),
            },
          ],
        },
      })
      const wall_clock_ms = Date.now() - start

      const newCompactionBlocks = extractCompactionBlocks(response.content)
      const responseText = extractAssistantText(response.content)
      const responseMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
      }

      // Emit compaction_event when server-side compaction fired this turn.
      // afterBytes ≈ size of compaction block content (the compacted summary)
      // plus the unchanged trailing messages — approximation, sufficient for
      // post-hoc analysis per design §3.1.
      if (newCompactionBlocks.length > 0) {
        const compactedContentBytes = newCompactionBlocks.reduce(
          (sum, b) => sum + (b.content?.length ?? 0),
          0,
        )
        const event: CompactionEvent = {
          type: 'reflection',
          turn_index,
          before_bytes: beforeBytes,
          after_bytes: compactedContentBytes,
        }
        const instrumentation: Instrumentation | undefined = opts?.instrumentation
        if (instrumentation) {
          instrumentation({ kind: 'compaction', payload: event })
        }
      }

      const usagePart = mapAnthropicUsage(
        {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          ...(response.usage.cache_read_input_tokens !== null
            ? { cache_read_input_tokens: response.usage.cache_read_input_tokens }
            : {}),
          ...(response.usage.cache_creation_input_tokens !== null
            ? { cache_creation_input_tokens: response.usage.cache_creation_input_tokens }
            : {}),
        },
        { wall_clock_ms, turn_index },
      )
      const telemetry: TurnRecord = composeTurnRecord(usagePart, {})

      const nextScratch: AnthropicScratch = {
        model: scratch.model,
        compaction_blocks:
          newCompactionBlocks.length > 0
            ? newCompactionBlocks
            : scratch.compaction_blocks,
      }

      return {
        response: responseMsg,
        state: {
          ...state,
          history: [...state.history, userMsg, responseMsg],
          scratch: { ...nextScratch },
        },
        telemetry,
        cost_usd: 0,
      }
    },
  }
}
