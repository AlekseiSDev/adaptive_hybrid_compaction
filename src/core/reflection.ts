import type { LLMCaller, LLMRequest } from './llm.js'
import { parseObservations } from './observerPrompt.js'
import { REFLECTOR_PROMPT_TEMPLATE } from './reflectorPrompt.js'
import { charsOver4TokenCounter, type TokenCounter } from './tokenCounter.js'
import type { Observation, Tier2 } from './types.js'

export type ReflectionReason = 'no_llm_caller' | 'parse_error'

export type ReflectionResult = {
  ran: boolean
  newTier2: Tier2
  beforeTokens: number
  afterTokens: number
  reason?: ReflectionReason
}

export type ReflectDeps = {
  tokenCounter?: TokenCounter
  llmCaller?: LLMCaller
}

function tier2Tokens(tier2: Tier2, counter: TokenCounter): number {
  const serialized = JSON.stringify(tier2.observations)
  return counter(serialized)
}

function buildRequest(tier2: Tier2): LLMRequest {
  const body = tier2.observations
    .map((o) => {
      const head = `- ${String(o.timestamp)} (${o.confidence}) ${o.statement}`
      if (!o.subDetails || o.subDetails.length === 0) return head
      return [head, ...o.subDetails.map((d) => `  - ${d}`)].join('\n')
    })
    .join('\n')
  return {
    messages: [
      { role: 'system', content: REFLECTOR_PROMPT_TEMPLATE },
      { role: 'user', content: `Current observation log:\n${body}` },
    ],
  }
}

function earliestSourceTurn(observations: readonly Observation[]): number {
  if (observations.length === 0) return 0
  let min = observations[0]?.sourceTurn ?? 0
  for (const o of observations) if (o.sourceTurn < min) min = o.sourceTurn
  return min
}

export async function reflect(tier2: Tier2, deps: ReflectDeps): Promise<ReflectionResult> {
  const counter = deps.tokenCounter ?? charsOver4TokenCounter
  const beforeTokens = tier2Tokens(tier2, counter)
  if (deps.llmCaller === undefined) {
    return {
      ran: false,
      newTier2: tier2,
      beforeTokens,
      afterTokens: beforeTokens,
      reason: 'no_llm_caller',
    }
  }
  const request = buildRequest(tier2)
  const response = await deps.llmCaller(request)
  let extracted: Observation[]
  try {
    extracted = parseObservations(response.text, earliestSourceTurn(tier2.observations))
  } catch {
    return {
      ran: false,
      newTier2: tier2,
      beforeTokens,
      afterTokens: beforeTokens,
      reason: 'parse_error',
    }
  }
  const newTier2: Tier2 = {
    observations: extracted,
    pointers: tier2.pointers,
    classSignal: tier2.classSignal,
  }
  const afterTokens = tier2Tokens(newTier2, counter)
  return { ran: true, newTier2, beforeTokens, afterTokens }
}
