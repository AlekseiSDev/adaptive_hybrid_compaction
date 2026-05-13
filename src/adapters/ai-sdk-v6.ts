import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
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
      const baseTools = (params.tools ?? []) as LanguageModelV3CallOptions['tools']
      const newTools =
        flags.RECALL_TOOL && scratchpad.size() > 0
          ? [...(baseTools ?? []), RECALL_FN_TOOL]
          : baseTools

      const merged: LanguageModelV3CallOptions = {
        ...params,
        prompt: newPrompt,
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
