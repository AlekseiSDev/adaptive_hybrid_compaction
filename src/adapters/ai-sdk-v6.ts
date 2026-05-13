import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider'
import {
  classifyWithHysteresis,
  compact,
  defaultFeatureFlags,
  defaultThresholds,
  recallToolDefinition,
  tierize,
  type CompactResult,
  type CoreEvent,
  type EventEmitter,
  type FeatureFlags,
  type HysteresisState,
  type LLMCaller,
  type Message,
  type Thresholds,
  type TrajectoryClass,
} from '../core/index.js'
import {
  convertCoreMessagesToSdk,
  convertSdkPromptToCore,
} from './messageConvert.js'
import { SessionScratchpadRegistry, type SessionId } from './sessionScratchpad.js'

export type AhcMiddlewareDeps = {
  flags?: Partial<FeatureFlags>
  thresholds?: Partial<Thresholds>
  llmCaller?: LLMCaller
  emit?: EventEmitter
  sessionId?: () => SessionId
  configuredClass?: TrajectoryClass
  scratchpadRegistry?: SessionScratchpadRegistry
  // Suppresses use of classifyWithHysteresis — tests / explicit class control.
  hysteresisStateOverride?: Map<SessionId, HysteresisState>
  // Fires after compact() completes; consumer reads newTier2 / events from result.
  // Not called on passthrough paths (no system message / tierize failure).
  onCompactResult?: (sessionId: SessionId, result: CompactResult) => void
  /**
   * E1: when true, mark the assembled system message with
   * `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`. Anthropic
   * API uses this hint to cache the prompt prefix up to and including the
   * marked message, enabling cache_read_input_tokens on subsequent turns.
   *
   * Consumers should set this iff the underlying provider speaks the
   * Anthropic protocol (anthropic_direct or LiteLLM-forwarded Anthropic);
   * OpenRouter/OpenAI passthrough ignores the field but emitting it on
   * non-Anthropic providers is wasted JSON. Default false (E0 semantics).
   *
   * Placement rationale: system prompt is the most stable element in the
   * AHC assembled context (Tier-1.systemPrompt; see assembleContext.ts).
   * Tier-2 observations / Tier-3 recent turns churn per-turn and would
   * invalidate any cache breakpoint placed past the system message.
   *
   * Cache-invariance: the providerOptions field is metadata, not content.
   * AHC output (assembledMessages) is byte-identical regardless of this
   * flag — only the SDK→provider serialization differs. Verified by
   * pnpm test:cache-invariance.
   */
  cacheControlEnabled?: boolean
}

// Synthesize light metadata so classifierFeatures.computeFeatures has turn_index hooks.
// Turn index increments when we encounter a new user message in chronological order.
function withDerivedMetadata(messages: readonly Message[]): Message[] {
  let turn = -1
  let step = 0
  const out: Message[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      turn += 1
      step = 0
    } else {
      step += 1
    }
    if (m.role === 'system') {
      out.push(m)
      continue
    }
    out.push({
      ...m,
      metadata: m.metadata ?? { turn_index: Math.max(0, turn), step_index: step },
    })
  }
  return out
}

function buildRecallFunctionTool(): LanguageModelV3FunctionTool {
  // recallToolDefinition is a frozen branded literal; we extract the published fields
  // for the SDK without touching the original reference (cache prefix stability).
  const def = recallToolDefinition as unknown as {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  return {
    type: 'function',
    name: def.name,
    description: def.description,
    inputSchema: def.parameters,
  }
}

const RECALL_FN_TOOL: LanguageModelV3FunctionTool = buildRecallFunctionTool()

// Marks the first system message in the assembled prompt with Anthropic's
// `cacheControl: ephemeral` hint so api.anthropic.com caches the prompt
// prefix up through that message. @ai-sdk/anthropic forwards providerOptions
// untouched; OpenRouter / OpenAI provider ignore it (no-op overhead).
//
// Returns a NEW prompt — never mutates the input. If no system message is
// present (compact() passthrough path returns params unchanged anyway, but
// belt-and-suspenders), returns the prompt as-is.
function withAnthropicCacheControlOnSystem(
  prompt: LanguageModelV3Prompt,
): LanguageModelV3Prompt {
  const idx = prompt.findIndex((m) => m.role === 'system')
  if (idx < 0) return prompt
  const cacheHint = {
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } },
  }
  const target = prompt[idx]
  if (target === undefined) return prompt
  return prompt.map((m, i) =>
    i === idx
      ? { ...m, ...cacheHint, providerOptions: { ...m.providerOptions, ...cacheHint.providerOptions } }
      : m,
  )
}

export function createAhcMiddleware(deps: AhcMiddlewareDeps): LanguageModelV3Middleware {
  const registry = deps.scratchpadRegistry ?? new SessionScratchpadRegistry()
  const hysteresisStates = deps.hysteresisStateOverride ?? new Map<SessionId, HysteresisState>()
  const flags: FeatureFlags = { ...defaultFeatureFlags, ...deps.flags }
  const thresholds: Thresholds = { ...defaultThresholds, ...deps.thresholds }

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const sessionId = deps.sessionId?.() ?? 'default'
      const coreMessages = convertSdkPromptToCore(params.prompt)
      if (coreMessages.length === 0 || !coreMessages.some((m) => m.role === 'system')) {
        return params
      }
      const enriched = withDerivedMetadata(coreMessages)
      const scratchpad = registry.get(sessionId)
      const prevState = hysteresisStates.get(sessionId)
      const lastUser = [...enriched].reverse().find((m) => m.role === 'user')
      const lastUserText =
        lastUser?.content.find((p) => p.type === 'text')?.text ?? ''

      let tierized: ReturnType<typeof tierize>
      try {
        tierized = tierize(enriched, { kRecent: thresholds.K_RECENT })
      } catch {
        // tierize requires exactly one system message and at least one user message;
        // if the caller violates this we fall back to passthrough.
        return params
      }

      const events: CoreEvent[] = []
      // dispatch() requires configuredClass when TRAJECTORY_CLASSIFIER=false.
      // Default to 'mixed' (offloader + observer both eligible) when caller did not set.
      const effectiveConfiguredClass: TrajectoryClass | undefined =
        deps.configuredClass ?? (flags.TRAJECTORY_CLASSIFIER ? undefined : 'mixed')
      const result = await compact({
        tier1: tierized.tier1,
        tier2: tierized.tier2,
        tier3: tierized.tier3,
        scratchpad,
        ...(prevState !== undefined ? { hysteresisState: prevState } : {}),
        flags,
        thresholds,
        ...(effectiveConfiguredClass !== undefined
          ? { configuredClass: effectiveConfiguredClass }
          : {}),
        deps: {
          ...(deps.llmCaller !== undefined ? { llmCaller: deps.llmCaller } : {}),
          currentQuery: lastUserText,
          emit: (e) => {
            events.push(e)
            deps.emit?.(e)
          },
        },
      })

      if (result.newHysteresisState !== undefined) {
        hysteresisStates.set(sessionId, result.newHysteresisState)
      }

      deps.onCompactResult?.(sessionId, result)

      const newPrompt = convertCoreMessagesToSdk(result.assembledMessages)
      const promptWithCacheHint = deps.cacheControlEnabled
        ? withAnthropicCacheControlOnSystem(newPrompt)
        : newPrompt
      const baseTools = (params.tools ?? []) as LanguageModelV3CallOptions['tools']
      const newTools =
        flags.RECALL_TOOL && scratchpad.size() > 0
          ? [...(baseTools ?? []), RECALL_FN_TOOL]
          : baseTools

      const merged: LanguageModelV3CallOptions = {
        ...params,
        prompt: promptWithCacheHint,
        ...(newTools !== undefined ? { tools: newTools } : {}),
      }
      // Classifier hysteresis update happens implicitly via compact(); we just need to
      // make sure the runtime side-effect is reachable by classifyWithHysteresis when
      // a caller wants to read class state directly. The expression below pins the
      // import so dead-code elimination can't drop it.
      void classifyWithHysteresis
      return merged
    },
  }
}
