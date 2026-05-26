import { assembleContext } from './assembleContext.js'
import { classifyWithHysteresis, type HysteresisState } from './classifier.js'
import { computeFeatures } from './classifierFeatures.js'
import { dispatch } from './dispatch.js'
import { defaultFeatureFlags, type FeatureFlags } from './featureFlags.js'
import type { CoreEvent, EventEmitter } from './events.js'
import type { LLMCaller } from './llm.js'
import { compactWithOffload } from './offloader.js'
import { maybeExtractObservations } from './observer.js'
import { injectRecallTool } from './recallTool.js'
import type { Scratchpad } from './scratchpad.js'
import { serializeForCache } from './serializeForCache.js'
import { defaultThresholds, type Thresholds } from './thresholds.js'
import {
  byteLengthOfContent,
  charsOver4TokenCounter,
  type ByteCounter,
  type TokenCounter,
} from './tokenCounter.js'
import type { ToolSchema } from './digest.js'
import { reflect } from './reflection.js'
import type {
  AtomicGroup,
  CompactionContext,
  ContentPart,
  Message,
  Observation,
  PointerPlaceholder,
  Tier1,
  Tier2,
  Tier3,
  TrajectoryClass,
} from './types.js'

export type CompactDeps = {
  byteCounter?: ByteCounter
  tokenCounter?: TokenCounter
  llmCaller?: LLMCaller
  toolSchema?: ToolSchema
  currentQuery?: string
  emit?: EventEmitter
}

export type CompactInput = {
  tier1: Tier1
  tier2: Tier2
  tier3: Tier3
  scratchpad: Scratchpad<AtomicGroup>
  hysteresisState?: HysteresisState
  flags?: FeatureFlags
  thresholds?: Thresholds
  configuredClass?: TrajectoryClass
  deps: CompactDeps
}

export type CompactResult = {
  assembledMessages: Message[]
  newTier1: Tier1
  newTier2: Tier2
  newTier3: Tier3
  newHysteresisState?: HysteresisState
  events: CoreEvent[]
  cachePrefixBytes: number
}

function totalContentBytes(messages: readonly Message[], byteCounter: ByteCounter): number {
  const parts: ContentPart[] = []
  for (const m of messages) parts.push(...m.content)
  return byteCounter(parts)
}

export async function compact(input: CompactInput): Promise<CompactResult> {
  const flags = input.flags ?? defaultFeatureFlags
  const thresholds = input.thresholds ?? defaultThresholds
  const byteCounter = input.deps.byteCounter ?? byteLengthOfContent
  const tokenCounter = input.deps.tokenCounter ?? charsOver4TokenCounter
  const events: CoreEvent[] = []
  const emit: EventEmitter = (e) => {
    events.push(e)
    input.deps.emit?.(e)
  }

  const history: Message[] = [
    ...input.tier1.firstUserMessages,
    ...input.tier3.recent,
    ...input.tier3.inflight.map((i) => i.tool_use),
  ]
  const features = computeFeatures(history)

  let trajectoryClass: TrajectoryClass
  let newHysteresisState: HysteresisState | undefined
  if (flags.TRAJECTORY_CLASSIFIER) {
    const result = classifyWithHysteresis(features, input.hysteresisState)
    trajectoryClass = result.class
    newHysteresisState = result.newState
  } else {
    trajectoryClass = input.configuredClass ?? 'mixed'
    newHysteresisState = input.hysteresisState
  }

  const turnIndex = Math.max(0, features.turns_total - 1)
  const confidence = features.turns_total >= 2 ? 1 : 0
  emit({
    kind: 'classifier_signal',
    turn_index: turnIndex,
    class: trajectoryClass,
    confidence,
  })

  const plan = dispatch({
    class: trajectoryClass,
    flags,
    ...(input.configuredClass !== undefined ? { configuredClass: input.configuredClass } : {}),
  })

  let tier3: Tier3 = input.tier3
  let newPointers: PointerPlaceholder[] = []
  if (plan.runOffloader) {
    const ctx: CompactionContext = {
      flags,
      groups_after_this: 0,
      cumulative_kept_tool_result_bytes: 0,
      current_class: trajectoryClass,
      thresholds,
    }
    const beforeBytes = totalContentBytes(tier3.recent, byteCounter)
    const offloadResult = await compactWithOffload(tier3, input.scratchpad, ctx, {
      byteCounter,
      ...(input.deps.llmCaller !== undefined ? { llmCaller: input.deps.llmCaller } : {}),
      ...(input.deps.toolSchema !== undefined ? { toolSchema: input.deps.toolSchema } : {}),
    })
    tier3 = offloadResult.tier3New
    newPointers = offloadResult.pointersAdded
    if (newPointers.length > 0) {
      const afterBytes = totalContentBytes(tier3.recent, byteCounter)
      emit({
        kind: 'compaction',
        type: 'offload',
        turn_index: turnIndex,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
      })
    }
  }

  let newObservations: Observation[] = []
  if (plan.runObserver) {
    const observerCtx: CompactionContext = {
      flags,
      groups_after_this: 0,
      cumulative_kept_tool_result_bytes: 0,
      current_class: trajectoryClass,
      thresholds,
    }
    const beforeBytes = totalContentBytes(tier3.recent, byteCounter)
    const obsResult = await maybeExtractObservations(tier3, input.tier2, observerCtx, {
      tokenCounter,
      currentQuery: input.deps.currentQuery ?? '',
      ...(input.deps.llmCaller !== undefined ? { llmCaller: input.deps.llmCaller } : {}),
    })
    if (obsResult.ran) {
      newObservations = obsResult.extracted
      tier3 = { ...tier3, recent: obsResult.clippedTier3 }
      const afterBytes = totalContentBytes(tier3.recent, byteCounter)
      emit({
        kind: 'compaction',
        type: 'observer',
        turn_index: turnIndex,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
        observations: newObservations,
        ...(obsResult.rawText !== undefined ? { observerRawText: obsResult.rawText } : {}),
      })
    }
  }

  let newTier2: Tier2 = {
    observations: [...input.tier2.observations, ...newObservations],
    pointers: [...input.tier2.pointers, ...newPointers],
    classSignal: {
      class: trajectoryClass,
      confidence,
      updatedAt: turnIndex,
    },
  }

  if (flags.REFLECTION) {
    const tier2TokensBefore = tokenCounter(JSON.stringify(newTier2.observations))
    if (tier2TokensBefore >= thresholds.REFLECTION_THRESHOLD) {
      const reflectResult = await reflect(newTier2, {
        tokenCounter,
        ...(input.deps.llmCaller !== undefined ? { llmCaller: input.deps.llmCaller } : {}),
      })
      if (reflectResult.ran) {
        newTier2 = reflectResult.newTier2
        emit({
          kind: 'compaction',
          type: 'reflection',
          turn_index: turnIndex,
          before_bytes: reflectResult.beforeTokens,
          after_bytes: reflectResult.afterTokens,
        })
      }
    }
  }

  const newTier1 = injectRecallTool(input.tier1, input.scratchpad, flags)
  const assembledMessages = assembleContext(newTier1, newTier2, tier3)
  const cachePrefixBytes = serializeForCache({ tier1: newTier1, tier2: newTier2 }).byteLength

  return {
    assembledMessages,
    newTier1,
    newTier2,
    newTier3: tier3,
    ...(newHysteresisState !== undefined ? { newHysteresisState } : {}),
    events,
    cachePrefixBytes,
  }
}
