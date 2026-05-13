import { generateText, type ModelMessage } from 'ai'
import { createAhcRuntime, type AhcProvider } from '../../adapters/ahc-runtime.js'
import { SessionScratchpadRegistry } from '../../adapters/sessionScratchpad.js'
import type {
  CoreEvent,
  FeatureFlags,
  HysteresisState,
  LLMCaller,
  LLMRequest as CoreLLMRequest,
  LLMResponse as CoreLLMResponse,
  Message,
} from '../../core/index.js'
import {
  ANTHROPIC_DIRECT_PRICING,
  createAnthropicClient,
  createOpenRouterClient,
  OPENROUTER_PRICING,
  type ModelPricing,
} from '../llm.js'
import { composeTurnRecord, mapAiSdkUsage, type AiSdkUsageShape } from '../telemetry.js'
import type {
  Baseline,
  BaselineState,
  BaselineStepResult,
  InstrumentationEvent,
  LLMClient,
  Task,
} from '../types.js'

// ahc_core baseline — real AHC runtime over AI SDK v6 provider, assembled via
// shared `createAhcRuntime` factory (src/adapters/ahc-runtime.ts). Per
// `docs/decisions.md [2026-05-13] E0 — Single shared AHC-over-AI-SDK runtime`,
// the actor+middleware wiring lives in adapters/ahc-runtime; this Baseline
// adds eval-specific concerns on top: cost-aware LLMCaller around the eval
// LLMClient (so step.cost_usd accounts for digest/observer/reflection), per-
// task scratchpad lifecycle, instrumentation collector → InstrumentationEvent.
//
// Provider switch (`'openrouter'` default, `'anthropic_direct'` for E3
// cache-hit subset) plumbed through deps; baseURL only meaningful on
// 'openrouter' (Anthropic uses SDK default).

const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3-flash-preview'
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
// AI SDK v6 recommends passing the system prompt as the top-level `system:`
// option rather than as a `{role:'system'}` entry in `messages:` (prompt-
// injection-attack mitigation). A6 middleware's `transformParams` reads the
// LanguageModelV3Prompt where the SDK has already lifted system into a
// dedicated entry — so the AHC middleware still observes it correctly.
const SYSTEM_PROMPT = 'You are a helpful assistant. Answer concisely.'

export type AhcCoreBaselineDeps = {
  apiKey: string
  baseURL?: string
  model?: string
  /**
   * Provider for the main actor + internal AHC LLM calls. 'openrouter'
   * (default) uses @ai-sdk/openai pointed at OpenRouter; 'anthropic_direct'
   * uses @ai-sdk/anthropic for E3 cache-hit subset.
   */
  provider?: AhcProvider
  ahcFlags?: Partial<FeatureFlags>
  pricing?: ModelPricing
  /**
   * Optional override of the LLMCaller used by AHC core for internal
   * digest/observer/reflection calls. Default: same provider+model as the
   * main generateText call, wrapped to accumulate cost.
   * Injecting custom caller is useful for tests.
   */
  llmCaller?: LLMCaller
  /** Optional injected LLMClient wrapper for tests. */
  llmClient?: LLMClient
}

type AhcScratch = {
  registry: SessionScratchpadRegistry
  hysteresis: Map<string, HysteresisState>
  internalCostUsdSinceLastStep: number
}

function resolveDefaultModel(provider: AhcProvider): string {
  return provider === 'anthropic_direct' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENROUTER_MODEL
}

function resolvePricing(provider: AhcProvider, model: string): ModelPricing {
  const table = provider === 'anthropic_direct' ? ANTHROPIC_DIRECT_PRICING : OPENROUTER_PRICING
  return table[model] ?? ZERO_PRICING
}

function defaultLlmClient(provider: AhcProvider, apiKey: string): LLMClient {
  if (provider === 'anthropic_direct') {
    return createAnthropicClient({ apiKey })
  }
  return createOpenRouterClient({ apiKey, appName: 'AHC' })
}

export function ahcCoreBaseline(deps: AhcCoreBaselineDeps): Baseline {
  const provider: AhcProvider = deps.provider ?? 'openrouter'
  const model = deps.model ?? resolveDefaultModel(provider)
  const pricing = deps.pricing ?? resolvePricing(provider, model)

  return {
    name: 'ahc_core',
    prepare: (task: Task): BaselineState => ({
      task_id: task.id,
      history: [],
      scratch: {
        registry: new SessionScratchpadRegistry(),
        hysteresis: new Map<string, HysteresisState>(),
        internalCostUsdSinceLastStep: 0,
      } satisfies AhcScratch as unknown as Record<string, unknown>,
    }),
    step: async (state, userMsg, opts): Promise<BaselineStepResult> => {
      if (!state.scratch) {
        throw new Error('ahcCoreBaseline.step: missing scratch (call prepare first)')
      }
      const scratch = state.scratch as unknown as AhcScratch
      scratch.internalCostUsdSinceLastStep = 0
      const turn_index = state.history.filter((m) => m.role === 'user').length
      const events: InstrumentationEvent[] = []

      // Cost-aware caller for AHC internal LLM calls (digest, observer,
      // reflection). Accumulator updated synchronously per-call so the
      // step.cost_usd we return at the end reflects all upstream consumption.
      const baseLlmCaller =
        deps.llmCaller ??
        wrapLlmClientAsLLMCaller(deps.llmClient ?? defaultLlmClient(provider, deps.apiKey), model)
      const costAwareLlmCaller = makeCostAwareLLMCaller(baseLlmCaller, pricing, (usd) => {
        scratch.internalCostUsdSinceLastStep += usd
      })

      // Shared AHC-over-AI-SDK assembly — provider switch (openrouter /
      // anthropic_direct), middleware wiring, scratchpad lifecycle all live
      // in createAhcRuntime. Eval-side adds the cost-aware llmCaller +
      // instrumentation collector below.
      const { model: wrapped } = createAhcRuntime({
        provider,
        apiKey: deps.apiKey,
        model,
        ...(deps.baseURL !== undefined ? { baseURL: deps.baseURL } : {}),
        ...(deps.ahcFlags !== undefined ? { flags: deps.ahcFlags } : {}),
        sessionId: () => state.task_id,
        scratchpadRegistry: scratch.registry,
        hysteresisStateOverride: scratch.hysteresis,
        emit: (e) => {
          events.push(mapCoreEventToInstrumentation(e))
        },
        llmCaller: costAwareLlmCaller,
      })
      const messages = toModelMessages([...state.history, userMsg])

      const start = Date.now()
      const result = await generateText({
        model: wrapped,
        system: SYSTEM_PROMPT,
        messages,
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'ahc.step',
          metadata: {
            task_id: state.task_id,
            turn_index: String(turn_index),
          },
        },
      })
      const wall_clock_ms = Date.now() - start

      // Surface events to the eval-side instrumentation sink (runSweep
      // aggregates them into TurnRecord.compaction_events / class_signal).
      for (const e of events) opts?.instrumentation?.(e)

      const usagePart = mapAiSdkUsage(result.usage as AiSdkUsageShape, {
        wall_clock_ms,
        turn_index,
      })
      const mainCost =
        ((usagePart.input_tokens ?? 0) * pricing.input_per_million_usd +
          (usagePart.output_tokens ?? 0) * pricing.output_per_million_usd) /
        1_000_000

      const compaction_events = events
        .filter((e): e is Extract<InstrumentationEvent, { kind: 'compaction' }> => e.kind === 'compaction')
        .map((e) => e.payload)
      const recall_events = events
        .filter((e): e is Extract<InstrumentationEvent, { kind: 'recall' }> => e.kind === 'recall')
        .map((e) => e.payload)
      const class_signal_event = events.find(
        (e): e is Extract<InstrumentationEvent, { kind: 'class_signal' }> => e.kind === 'class_signal',
      )

      const responseMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: result.text }],
      }
      return {
        response: responseMsg,
        state: {
          ...state,
          history: [...state.history, userMsg, responseMsg],
          scratch: scratch as unknown as Record<string, unknown>,
        },
        telemetry: composeTurnRecord(usagePart, {
          compaction_events,
          recall_events,
          ...(class_signal_event !== undefined
            ? {
                class_signal: {
                  class: class_signal_event.class,
                  confidence: class_signal_event.confidence,
                },
              }
            : {}),
        }),
        cost_usd: mainCost + scratch.internalCostUsdSinceLastStep,
      }
    },
  }
}

const ZERO_PRICING: ModelPricing = {
  input_per_million_usd: 0,
  output_per_million_usd: 0,
}

// Wraps an eval-side LLMClient (provider-neutral, src/eval/types.ts) into
// the core LLMCaller interface (src/core/llm.ts). The two shapes differ:
// core uses { messages, maxOutputTokens?, temperature? } and returns
// { text, usage?:{promptTokens?, completionTokens?} } — no model, no
// raw_usage; eval-side LLMClient takes { model, messages, max_tokens?,
// temperature? } and returns { text, raw_usage, finish_reason, latency_ms,
// error? }. Bridge: model is bound at construction time; raw_usage is
// projected into the core usage shape so internal AHC code can read tokens
// without provider-specific keys.
export function wrapLlmClientAsLLMCaller(client: LLMClient, model: string): LLMCaller {
  return async (req: CoreLLMRequest): Promise<CoreLLMResponse> => {
    const evalReq = {
      model,
      messages: req.messages,
      ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }
    const resp = await client(evalReq)
    if (resp.error) {
      // Surface a plain Error — core observer / digest treat throw as
      // "skip this internal call, continue best-effort".
      throw new Error(`LLMCaller upstream error: ${resp.error.kind} ${resp.error.message}`)
    }
    const usage = resp.raw_usage
    const promptTokens =
      usage !== null && 'prompt_tokens' in usage ? usage.prompt_tokens : undefined
    const completionTokens =
      usage !== null && 'completion_tokens' in usage ? usage.completion_tokens : undefined
    return {
      text: resp.text,
      ...(promptTokens !== undefined || completionTokens !== undefined
        ? {
            usage: {
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {}),
            },
          }
        : {}),
    }
  }
}

export function makeCostAwareLLMCaller(
  base: LLMCaller,
  pricing: ModelPricing,
  onCost: (usd: number) => void,
): LLMCaller {
  return async (req: CoreLLMRequest): Promise<CoreLLMResponse> => {
    const resp = await base(req)
    const prompt = resp.usage?.promptTokens ?? 0
    const completion = resp.usage?.completionTokens ?? 0
    const usd =
      (prompt * pricing.input_per_million_usd +
        completion * pricing.output_per_million_usd) /
      1_000_000
    if (usd > 0) onCost(usd)
    return resp
  }
}

export function mapCoreEventToInstrumentation(e: CoreEvent): InstrumentationEvent {
  if (e.kind === 'compaction') {
    return {
      kind: 'compaction',
      payload: {
        type: e.type,
        turn_index: e.turn_index,
        before_bytes: e.before_bytes,
        after_bytes: e.after_bytes,
        ...(e.llm_cost_usd !== undefined ? { llm_cost_usd: e.llm_cost_usd } : {}),
      },
    }
  }
  if (e.kind === 'recall') {
    return {
      kind: 'recall',
      payload: {
        recall_id: e.recall_id,
        tool_name: e.tool_name,
        reason: e.reason,
        turn_index: e.turn_index,
      },
    }
  }
  // classifier_signal → class_signal rename per src/eval/types.ts:165-168
  return {
    kind: 'class_signal',
    turn_index: e.turn_index,
    class: e.class,
    confidence: e.confidence,
  }
}

// Convert AHC core Message[] to AI SDK ModelMessage[]. Core uses content as
// ContentPart[] with `{type:'text', text}`-style entries — AI SDK's
// ModelMessage accepts the same. We narrow to roles AI SDK recognises and
// re-emit text content. Non-text parts (tool_use / tool_result / reasoning)
// are not produced by the synthetic adapter today; D-track AssistantTraj
// adapter will exercise that path later (out of scope for B5).
function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of messages) {
    const text = m.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter((t) => t.length > 0)
      .join('\n')
    if (text.length === 0) continue
    if (m.role === 'system') {
      out.push({ role: 'system', content: text })
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: text })
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: text })
    }
    // 'tool' role messages dropped on this path — out of scope for B5.
  }
  return out
}
