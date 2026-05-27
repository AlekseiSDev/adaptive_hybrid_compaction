import { wrapLanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAhcMiddleware, type AhcMiddlewareDeps } from './ai-sdk-v6.js'
import { type SessionScratchpadRegistry, type SessionId } from './sessionScratchpad.js'
import type {
  CompactResult,
  CoreEvent,
  FeatureFlags,
  HysteresisState,
  LLMCaller,
  Thresholds,
  Tier2,
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

export type AhcProvider = 'openrouter' | 'anthropic_direct' | 'google_direct'

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
  /**
   * Optional threshold overrides forwarded to `createAhcMiddleware`. Use to
   * tune OBSERVER_THRESHOLD / T_SIZE / TIER3_TOKEN_BUDGET per-sweep (e.g.
   * Track H P1 lme-multiturn sweep lowers OBSERVER_THRESHOLD 8000 → 4000 to
   * fire observer reliably on session-per-turn replay).
   */
  thresholds?: Partial<Thresholds>
  sessionId: () => SessionId
  scratchpadRegistry: SessionScratchpadRegistry
  hysteresisStateOverride?: Map<SessionId, HysteresisState>
  /**
   * Persistent Tier-2 registry across `generateText` calls on the same
   * sessionId. H Phase 9 decisions.md 2026-05-22 D1 promised cross-turn
   * Tier-2 persistence in the adapter, but the eval baseline path
   * (`src/eval/runners/ahc_core.ts`) re-created the runtime per
   * `baseline.step()`, dropping the registry — observations didn't actually
   * accumulate across turns. This option lets the caller pin a registry that
   * lives across step() calls (parallel to `scratchpadRegistry` /
   * `hysteresisStateOverride`); without it, every runtime gets a fresh map
   * and behaves like pre-H9.
   */
  tier2Registry?: Map<SessionId, Tier2>
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

// Ensures the baseURL ends with `/v1` (Anthropic API version segment) so the
// AI SDK's request path resolution (`<baseURL>/messages`) lands on the
// proxy's `/v1/messages` endpoint. Idempotent — does nothing if already
// suffixed. Strips trailing slashes first to avoid `//v1`.
function withV1Suffix(url: string): string {
  const stripped = url.replace(/\/+$/, '')
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`
}

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
  if (opts.provider === 'anthropic_direct') {
    // @ai-sdk/anthropic expects baseURL to include the API version segment
    // (default: 'https://api.anthropic.com/v1'); it appends '/messages' for
    // the request path. Raw @anthropic-ai/sdk (used elsewhere for AHC's
    // internal LLMCaller) appends '/v1/messages' itself. To accept the
    // same env-supplied LITELLM_BASE_URL (typically `http://host:port`
    // with no `/v1`), we normalize here by ensuring trailing `/v1`.
    const baseURL = opts.baseURL !== undefined ? withV1Suffix(opts.baseURL) : undefined
    const anthropic = createAnthropic({
      apiKey: opts.apiKey,
      ...(baseURL !== undefined ? { baseURL } : {}),
    })
    return anthropic(opts.model)
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (opts.provider === 'google_direct') {
    // Track H P4 (2026-05-14): direct Google AI Studio path for honest
    // Gemini cache_read measurement. OpenRouter passthrough strips
    // `usageMetadata.cachedContentTokenCount` from Gemini responses (probe
    // 2026-05-13, docs/investigations/openrouter-cache-passthrough.md round 2);
    // direct API exposes it. Implicit cache fires automatically on ≥1024-token
    // stable prefix — no providerOptions hint required; cacheControlEnabled
    // stays false for google_direct (asymmetric vs anthropic_direct).
    const google = createGoogleGenerativeAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    })
    return google.chat(opts.model)
  }
  throw new Error(`createAhcRuntime: unsupported provider: ${String(opts.provider)}`)
}

export function createAhcRuntime(opts: AhcRuntimeOptions): AhcRuntime {
  const baseModel = buildBaseModel(opts)

  // E1: Anthropic-protocol providers honor providerOptions.anthropic.cacheControl
  // to cache prompt prefix; OpenRouter/OpenAI passthrough ignores it. AHC marks
  // the system message in the assembled prompt — most stable element across
  // turns (see assembleContext.ts: tier1.systemPrompt). Enabled only for
  // anthropic_direct provider (whether direct API or LiteLLM-forwarded).
  const cacheControlEnabled = opts.provider === 'anthropic_direct'
  const middlewareDeps: AhcMiddlewareDeps = {
    sessionId: opts.sessionId,
    scratchpadRegistry: opts.scratchpadRegistry,
    cacheControlEnabled,
    ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
    ...(opts.thresholds !== undefined ? { thresholds: opts.thresholds } : {}),
    ...(opts.hysteresisStateOverride !== undefined
      ? { hysteresisStateOverride: opts.hysteresisStateOverride }
      : {}),
    ...(opts.tier2Registry !== undefined ? { tier2Registry: opts.tier2Registry } : {}),
    ...(opts.emit !== undefined ? { emit: opts.emit } : {}),
    ...(opts.onCompactResult !== undefined ? { onCompactResult: opts.onCompactResult } : {}),
    ...(opts.llmCaller !== undefined ? { llmCaller: opts.llmCaller } : {}),
  }
  const middleware = createAhcMiddleware(middlewareDeps)

  return {
    model: wrapLanguageModel({ model: baseModel, middleware }),
  }
}
