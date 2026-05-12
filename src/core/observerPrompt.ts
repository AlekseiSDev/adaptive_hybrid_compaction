import type { Observation } from './types.js'

// Verbatim from `design/A_ahc-algorithm.md §4.2`. The bulleted-list output
// format is also captured here so `parseObservations` round-trips.
export const OBSERVER_PROMPT_TEMPLATE = `You are a conversation observer. Given:
  - Recent messages: <Tier-3 fragment>
  - Current user query: <query>
  - Previous observations: <Tier-2 tail, last 4K tokens>

Extract observations that:
  1. Are relevant to current query OR could be relevant to similar follow-up queries
  2. Are factual statements (preferences, decisions, knowledge updates), not chit-chat
  3. Reference specific entities (user, files, prior turns)
  4. Mark confidence: high|med|low

Output format:
- timestamp (high|med|low) factual statement
  - sub-detail (if any)
`

const OBSERVATION_LINE = /^-\s+(\d+)\s+\((high|med|low)\)\s+(.+)$/
const SUB_DETAIL_LINE = /^\s{2,}-\s+(.+)$/
const CONFIDENCE_LINE_HINT = /^-\s+\d+\s+\([^)]+\)/

export function parseObservations(raw: string, sourceTurn: number): Observation[] {
  const lines = raw.split(/\r?\n/)
  const observations: Observation[] = []
  let current: Observation | undefined

  for (const line of lines) {
    if (line.trim().length === 0) continue

    const obsMatch = OBSERVATION_LINE.exec(line)
    if (obsMatch) {
      const [, ts, conf, statement] = obsMatch
      if (ts === undefined || conf === undefined || statement === undefined) continue
      current = {
        timestamp: Number(ts),
        confidence: conf as Observation['confidence'],
        statement,
        sourceTurn,
      }
      observations.push(current)
      continue
    }

    const subMatch = SUB_DETAIL_LINE.exec(line)
    if (subMatch && current) {
      const [, detail] = subMatch
      if (detail === undefined) continue
      const subs = current.subDetails ?? []
      subs.push(detail)
      current.subDetails = subs
      continue
    }

    if (CONFIDENCE_LINE_HINT.test(line)) {
      // Looked like an observation line but the confidence didn't match — surface it.
      throw new Error(`parseObservations: unknown confidence in line: ${line}`)
    }
  }

  return observations
}
