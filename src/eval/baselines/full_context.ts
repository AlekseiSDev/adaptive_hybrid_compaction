import { costFromUsage } from '../llm.js'
import { composeTurnRecord, mapOpenRouterUsage } from '../telemetry.js'
import type {
  Baseline,
  LLMClient,
  LLMMessage,
  Message,
  OpenRouterUsage,
  TurnRecord,
} from '../types.js'

// FullContext baseline (de facto Track C C3, ships in B2 — see decisions.md
// 2026-05-13 B2 entries). Pass-through accumulation: history grows verbatim,
// no compaction. Upper-bound accuracy + sanity check vs AHC.
//
// Text-only conversion. Multimodal / tool_use messages are coerced to text
// (best-effort) — full multimodal support lands when AssistantTraj bench is wired.

export type FullContextDeps = {
  llmClient: LLMClient
  model: string
}

function messageToLLM(msg: Message): LLMMessage | null {
  if (msg.role === 'tool') return null
  const text = msg.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
  if (text.length === 0) return null
  return { role: msg.role, content: text }
}

export function fullContextBaseline(deps: FullContextDeps): Baseline {
  return {
    name: 'full_context',
    prepare: (task) => ({
      task_id: task.id,
      history: [],
      scratch: { model: deps.model },
    }),
    step: async (state, userMsg, _opts) => {
      const newHistory = [...state.history, userMsg]
      const llmMessages = newHistory
        .map(messageToLLM)
        .filter((m): m is LLMMessage => m !== null)
      const turn_index = newHistory.filter((m) => m.role === 'user').length - 1

      const start = Date.now()
      const response = await deps.llmClient({
        model: deps.model,
        messages: llmMessages,
      })
      const wall_clock_ms = Date.now() - start

      if (response.error) {
        throw new Error(
          `LLM ${response.error.kind}: ${response.error.message}`,
        )
      }

      const responseMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: response.text }],
      }

      const usage: OpenRouterUsage =
        response.raw_usage !== null
          ? (response.raw_usage as OpenRouterUsage)
          : { prompt_tokens: 0, completion_tokens: 0 }
      const usagePart = mapOpenRouterUsage(usage, { wall_clock_ms, turn_index })
      const telemetry: TurnRecord = composeTurnRecord(usagePart, {})
      const cost_usd = costFromUsage(deps.model, usage)

      return {
        response: responseMsg,
        state: { ...state, history: [...newHistory, responseMsg] },
        telemetry,
        cost_usd,
      }
    },
  }
}
