import { generateText, type ModelMessage } from 'ai'
import { createAhcRuntime, type AhcProvider } from '../../adapters/ahc-runtime.js'
import { SessionScratchpadRegistry } from '../../adapters/sessionScratchpad.js'
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../../core/prompts.js'
import type {
  CoreEvent,
  FeatureFlags,
  HysteresisState,
  LLMCaller,
  LLMRequest as CoreLLMRequest,
  LLMResponse as CoreLLMResponse,
  Message,
  Thresholds,
} from '../../core/index.js'
import {
  ANTHROPIC_DIRECT_PRICING,
  GOOGLE_DIRECT_PRICING,
  createAnthropicClient,
  createOpenRouterClient,
  OPENROUTER_PRICING,
  resolveActorModel,
  type ModelPricing,
} from '../llm.js'
import { composeTurnRecord, mapAiSdkUsage } from '../telemetry.js'
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

// Per decisions.md 2026-05-13 pivot — supersedes gemini-3-flash-preview.
// gpt-5.4-mini has automatic prompt cache on OpenRouter for ≥1024-token
// stable prefix; AHC's stable Tier-1 prefix benefits.
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.4-mini'
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const DEFAULT_GOOGLE_DIRECT_MODEL = 'gemini-3-flash-preview'

// AHC_ACTOR_MODEL env override → shared helper `resolveActorModel` in
// src/eval/llm.ts (Track H H1: 4 default-constant sites consolidated).
// Per-config `ahc_flags.model` in sweep YAML takes precedence over env.
// AI SDK v6 recommends passing the system prompt as the top-level `system:`
// option rather than as a `{role:'system'}` entry in `messages:` (prompt-
// injection-attack mitigation). A6 middleware's `transformParams` reads the
// LanguageModelV3Prompt where the SDK has already lifted system into a
// dedicated entry — so the AHC middleware still observes it correctly.
// Default content lives in `src/core/prompts.ts` (DEFAULT_AGENT_SYSTEM_PROMPT)
// so eval baselines, UI, and AHC actor share the same agentic framing.

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
  /**
   * Optional threshold overrides (Track H P1). Forwarded to
   * `createAhcRuntime` which merges with `defaultThresholds` inside the
   * middleware. Used by the lme-multiturn sweep to drop
   * `OBSERVER_THRESHOLD` from 8000 → 4000 so observer fires reliably on
   * Mode A session-per-turn replay (per docs/design/H_ablations_and_TODOs §12.2).
   */
  thresholds?: Partial<Thresholds>
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
  /**
   * System prompt passed via top-level `system:` to `generateText`. Default:
   * `DEFAULT_AGENT_SYSTEM_PROMPT` from core (shared with all other baselines
   * for fair-comparison invariant).
   */
  systemPrompt?: string
}

type AhcScratch = {
  registry: SessionScratchpadRegistry
  hysteresis: Map<string, HysteresisState>
  internalCostUsdSinceLastStep: number
}

function resolveDefaultModel(provider: AhcProvider): string {
  if (provider === 'anthropic_direct') return DEFAULT_ANTHROPIC_MODEL
  if (provider === 'google_direct') return resolveActorModel(DEFAULT_GOOGLE_DIRECT_MODEL)
  return resolveActorModel(DEFAULT_OPENROUTER_MODEL)
}

function resolvePricing(provider: AhcProvider, model: string): ModelPricing {
  let table: Record<string, ModelPricing>
  if (provider === 'anthropic_direct') table = ANTHROPIC_DIRECT_PRICING
  else if (provider === 'google_direct') table = GOOGLE_DIRECT_PRICING
  else table = OPENROUTER_PRICING
  return table[model] ?? ZERO_PRICING
}

function defaultLlmClient(
  provider: AhcProvider,
  apiKey: string,
  baseURL: string | undefined,
): LLMClient {
  if (provider === 'anthropic_direct') {
    return createAnthropicClient({
      apiKey,
      ...(baseURL !== undefined ? { baseURL } : {}),
    })
  }
  if (provider === 'google_direct') {
    // AHC internal calls (digest, observer, reflection) need an LLM caller.
    // Native @ai-sdk/google routes through `chat()`, but our LLMCaller surface
    // is provider-neutral chat-completions style — Google direct doesn't fit
    // without a Google→LLMClient adapter (out of scope for H3.1 v1).
    // Fallback: route internal calls through OpenRouter (small prompts, $0.01
    // cost negligible). Documented asymmetry — main actor + cache_read on
    // Gemini direct, AHC internals on OpenRouter. P4 acceptance unaffected.
    const openrouterKey = process.env['OPENROUTER_API_KEY']
    if (!openrouterKey || openrouterKey.length === 0) {
      throw new Error(
        'provider=google_direct requires OPENROUTER_API_KEY for AHC internal calls (digest/observer). Set it in .env.',
      )
    }
    return createOpenRouterClient({ apiKey: openrouterKey, appName: 'AHC' })
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
      } satisfies AhcScratch,
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
        wrapLlmClientAsLLMCaller(
          deps.llmClient ?? defaultLlmClient(provider, deps.apiKey, deps.baseURL),
          model,
        )
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
        ...(deps.thresholds !== undefined ? { thresholds: deps.thresholds } : {}),
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
        system: deps.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
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

      const usagePart = mapAiSdkUsage(result.usage, {
        wall_clock_ms,
        turn_index,
      })
      const mainCost =
        (usagePart.input_tokens * pricing.input_per_million_usd +
          usagePart.output_tokens * pricing.output_per_million_usd) /
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
          scratch: scratch,
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
        ...(e.observations !== undefined ? { observations: e.observations } : {}),
        ...(e.observerRawText !== undefined ? { observerRawText: e.observerRawText } : {}),
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
