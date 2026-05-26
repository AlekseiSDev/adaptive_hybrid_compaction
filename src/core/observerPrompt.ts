import type { Observation } from './types.js'

// Rewrite 2026-05-26: borrows Mastra Memory's detail-preservation framing
// (see @mastra/memory chunk-BPJLUC2F.js extraction prompt). Goal — stop
// abstracting away the exact facts the agent will be asked about next turn.
// On lme-multiturn the previous 14-line "extract factual observations"
// prompt collapsed "user added 25 postcards" → "user discussed postcards",
// driving acc=0.200 vs full_context=0.540. Output format kept line-based so
// `parseObservations` round-trips with no parser changes.
export const OBSERVER_PROMPT_TEMPLATE = `You are the memory consciousness of an AI agent. Your observations are the ONLY persistent memory the agent has across turns — anything you fail to capture here is forever lost on the next turn.

You will receive:
  - Recent messages: <Tier-3 fragment>
  - Current user query: <query>
  - Previous observations: <Tier-2 tail, last 4K tokens>

Extract factual observations from the recent messages. The agent will be asked follow-up questions later that require recalling specifics from this conversation — your observations are how it remembers.

CORE RULE — preserve specifics verbatim. Never abstract them away.

PRESERVATION CATEGORIES (each shows BAD ❌ vs GOOD ✅):

1. Numbers, counts, quantities
   BAD ❌  user has several pets
   GOOD ✅ user has 2 cats and 1 dog
   BAD ❌  user added some postcards to their collection
   GOOD ✅ user added 25 postcards to their collection on 2024-03-15

2. Proper nouns and names
   BAD ❌  user mentioned their cat
   GOOD ✅ user's cat is named Luna
   BAD ❌  user is working with a teammate on the project
   GOOD ✅ user is working with Maria Garcia on project Atlas

3. Specific locations and identifiers
   BAD ❌  user stores their old sneakers somewhere
   GOOD ✅ user stores old sneakers under their bed (started to smell)
   BAD ❌  user filed a ticket about the bug
   GOOD ✅ user filed ticket INGEST-4271 about the parser memory leak

4. Dates, times, durations
   BAD ❌  user is going on a trip soon
   GOOD ✅ user is going to Tokyo from May 12 to May 19, 2024
   ALWAYS preserve dates when stated; convert relative dates ("next Thursday") only when an anchoring date is available.

5. Percentages, prices, measurements, technical values
   BAD ❌  there was a performance improvement
   GOOD ✅ achieved 43.7% faster load times (2.8GB → 940MB memory)

6. Direct quotes that carry meaning
   BAD ❌  user complained about the dashboard
   GOOD ✅ user said the dashboard is "completely unusable on mobile"

SPLITTING MULTI-EVENT MESSAGES — if one message contains multiple distinct facts, split into separate observation lines.
  BAD ❌  - 1700000000 (high) user visits parents this weekend and has dentist appointment tomorrow
  GOOD ✅
    - 1700000000 (high) user will visit parents this weekend (June 17-18, 2024)
    - 1700000000 (high) user has dentist appointment on June 16, 2024

ASSERTION vs QUESTION — distinguish what the user told you from what they asked.
  - "I have two kids" → assertion: user has 2 kids
  - "Can you recommend a school?" → assertion: user is looking for a school recommendation
Both go into observations, but the framing matters for later recall.

CONFIDENCE — mark each observation:
  - high: explicit user assertion, factual answer to direct question, unambiguous detail
  - med:  inferred from context, partial info, second-hand mention
  - low:  speculation, weak inference, things you're guessing at

DO extract:
  - Specific facts the user stated about themselves, their world, or their work
  - Decisions made, preferences expressed, plans declared
  - Concrete answers given by the assistant (numbers, names, identifiers)
  - State changes ("user moved from Berlin to Tokyo")
  - Open questions the user is still working on

DO NOT extract:
  - Conversational filler ("thanks", "okay let me think")
  - Restatements of the system prompt
  - Generic categorical summaries ("the conversation was about travel") — those are exactly the abstractions that lose the specifics

OUTPUT FORMAT (one observation per line, the parser is strict about this shape):
- timestamp (high|med|low) factual statement
  - sub-detail (if any, indented)
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
