import type { Observation } from './types.js'

// Rewrite 2026-05-26: borrowed Mastra Memory's detail-preservation framing.
// Refit 2026-05-27 after lme-mt n=3 observer-debug sweep showed 7/8 empty
// fires came from Gemini-3.1-Flash writing ISO dates (`2023-11-30`, `2023/08/11`)
// where the parser required integer epoch — see decisions.md [2026-05-27]
// + docs/runs/current.md Track H "Observer prompt parse-failure" closure note.
// The 8th empty fire was a refusal/answer-leak (LLM wrote `25\n` instead of
// observations); mitigated by the explicit "DO NOT answer" rule below.
export const OBSERVER_PROMPT_TEMPLATE = `You are the memory consciousness of an AI agent. Your observations are the ONLY persistent memory the agent has across turns — anything you fail to capture here is forever lost on the next turn.

You will receive:
  - Recent messages: <Tier-3 fragment>
  - Current user query: <query>
  - Previous observations: <Tier-2 tail, last 4K tokens>

DO NOT answer the user's current query. Your job is ONLY to extract factual observations from the recent messages — never to respond to the query itself. The query is provided so you know what kind of facts will matter next, not for you to answer.

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
  BAD ❌  - 2024-06-17 (high) user visits parents this weekend and has dentist appointment tomorrow
  GOOD ✅
    - 2024-06-17 (high) user will visit parents this weekend (June 17-18, 2024)
    - 2024-06-16 (high) user has dentist appointment on June 16, 2024

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
  - The answer to the user's current query (see top of prompt)

OUTPUT FORMAT — strict. One observation per line. Use this exact shape:

  - YYYY-MM-DD (high|med|low) factual statement
    - sub-detail (if any, indented two spaces)

Use ISO date YYYY-MM-DD for the timestamp (anchored to when the fact was stated, not when it occurred). No preamble. No markdown headers. No explanation. ONLY observation lines.

EXAMPLE OUTPUT (mimic this shape exactly):

  - 2024-03-15 (high) user added 25 postcards to their collection
  - 2024-03-15 (high) user's cat is named Luna
    - cat is a 4-year-old British Shorthair
  - 2024-03-15 (med) user is considering moving from Berlin to Tokyo in fall 2024
`

const ISO_DATE_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}`
const SLASH_DATE_TIMESTAMP = String.raw`\d{4}\/\d{2}\/\d{2}`
const INT_TIMESTAMP = String.raw`\d+`
const TIMESTAMP_GROUP = `(${ISO_DATE_TIMESTAMP}|${SLASH_DATE_TIMESTAMP}|${INT_TIMESTAMP})`

const OBSERVATION_LINE = new RegExp(
  `^-\\s+${TIMESTAMP_GROUP}\\s+\\((high|med|low)\\)\\s+(.+)$`,
)
const SUB_DETAIL_LINE = /^\s{2,}-\s+(.+)$/
const CONFIDENCE_LINE_HINT = new RegExp(
  `^-\\s+${TIMESTAMP_GROUP}\\s+\\([^)]+\\)`,
)

function parseTimestampField(raw: string): number {
  // Integer epoch path (10-digit seconds, 13-digit ms, etc.) — preserve as-is.
  if (/^\d+$/.test(raw)) return Number(raw)
  // Date path — normalise slashes to dashes so Date.parse hits the ISO branch
  // consistently (Date.parse('2023/08/11') is local-time on some runtimes;
  // ISO 'YYYY-MM-DD' is UTC midnight by spec — predictable & cross-platform).
  const iso = raw.replace(/\//g, '-')
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`parseObservations: unparseable timestamp "${raw}"`)
  }
  // Store as epoch seconds for symmetry with existing 10-digit integer cases.
  return Math.floor(ms / 1000)
}

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
        timestamp: parseTimestampField(ts),
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
