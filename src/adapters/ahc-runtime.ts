import { wrapLanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createAhcMiddleware, type AhcMiddlewareDeps } from './ai-sdk-v6.js'
import { type SessionScratchpadRegistry, type SessionId } from './sessionScratchpad.js'
import type {
  CompactResult,
  CoreEvent,
  FeatureFlags,
  HysteresisState,
  LLMCaller,
} from '../core/index.js'

// createAhcRuntime — canonical assembly of AHC over AI SDK v6 provider.
// Single source of truth for the `createOpenAI/createAnthropic + .chat() +
// wrapLanguageModel({middleware: createAhcMiddleware})` wiring. Both eval
// (src/eval/runners/ahc_core.ts) and G/UI (src/ui/app/api/chat/route.ts)
// consume this — eliminates the duplicated inline-wiring that previously
// drifted between sides.
//
// Provider abstraction:
//   - 'openrouter' → @ai-sdk/openai pointed at OpenRouter base URL +
//     `.chat(model)` (OpenRouter rejects the Responses API default). Primary
//     actor for sweeps E1/E2.
//   - 'anthropic_direct' → @ai-sdk/anthropic native provider for
//     claude-sonnet-4-6. E3 cache-hit subset.
//
// Internal LLMCaller (digest / observer / reflection) is the caller's
// responsibility — eval-side wraps an eval LLMClient with cost accounting,
// UI-side leaves it undefined (AHC core uses rule-based digest fallback and
// no-op observer when caller absent, per A2/A3 decisions in decisions.md).
// Pricing tables (OPENROUTER_PRICING, ANTHROPIC_DIRECT_PRICING) live in
// src/eval/llm.ts — eval-side concern, not part of this layer.

export type AhcProvider = 'openrouter' | 'anthropic_direct'

export type AhcRuntimeOptions = {
  provider: AhcProvider
  apiKey: string
  model: string
  /**
   * Optional base URL override. For 'openrouter' defaults to
   * `https://openrouter.ai/api/v1`. For 'anthropic_direct' enables routing
   * through a forwarder (e.g. corporate LiteLLM proxy speaking the Anthropic
   * protocol) — value passed to `createAnthropic({apiKey, baseURL})`.
   */
  baseURL?: string
  flags?: Partial<FeatureFlags>
  sessionId: () => SessionId
  scratchpadRegistry: SessionScratchpadRegistry
  hysteresisStateOverride?: Map<SessionId, HysteresisState>
  emit?: (event: CoreEvent) => void
  onCompactResult?: (sessionId: SessionId, result: CompactResult) => void
  /**
   * LLMCaller for AHC core internal calls (digest, observer, reflection).
   * Optional — undefined means digest falls back to rule-based truncation
   * and observer is no-op (per A2/A3 decisions). Eval-side passes a
   * cost-aware wrapper around its LLMClient; UI-side leaves undefined.
   */
  llmCaller?: LLMCaller
}

export type AhcRuntime = {
  model: LanguageModelV3
}

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

function buildBaseModel(opts: AhcRuntimeOptions): LanguageModelV3 {
  // Runtime guard against type-system escapes (cast / JSON-sourced provider
  // string). TS narrows opts.provider to the literal union, but we accept
  // runtime values from sweep YAML — validator throws first, but defense in
  // depth here for direct API callers (G/UI, tests).
  if (opts.provider === 'openrouter') {
    const openai = createOpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? OPENROUTER_DEFAULT_BASE_URL,
    })
    // .chat() routes through OpenAI Chat Completions API; openai(modelId)
    // hits the Responses API which OpenRouter rejects mid-stream after
    // tool calls. See decisions.md 2026-05-13 OpenRouter + @ai-sdk/openai.
    return openai.chat(opts.model)
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (opts.provider === 'anthropic_direct') {
    const anthropic = createAnthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    })
    return anthropic(opts.model)
  }
  throw new Error(`createAhcRuntime: unsupported provider: ${String(opts.provider)}`)
}

export function createAhcRuntime(opts: AhcRuntimeOptions): AhcRuntime {
  const baseModel = buildBaseModel(opts)

  const middlewareDeps: AhcMiddlewareDeps = {
    sessionId: opts.sessionId,
    scratchpadRegistry: opts.scratchpadRegistry,
    ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
    ...(opts.hysteresisStateOverride !== undefined
      ? { hysteresisStateOverride: opts.hysteresisStateOverride }
      : {}),
    ...(opts.emit !== undefined ? { emit: opts.emit } : {}),
    ...(opts.onCompactResult !== undefined ? { onCompactResult: opts.onCompactResult } : {}),
    ...(opts.llmCaller !== undefined ? { llmCaller: opts.llmCaller } : {}),
  }
  const middleware = createAhcMiddleware(middlewareDeps)

  return {
    model: wrapLanguageModel({ model: baseModel, middleware }),
  }
}
