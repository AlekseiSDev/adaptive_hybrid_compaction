// Rewrite 2026-05-26 — borrows Mastra reflector framing
// (@mastra/memory chunk-BPJLUC2F.js:3993). Pre-rewrite, the 14-line "merge
// related, drop outdated" instruction implicitly invited the model to
// aggregate distinguishing facts (counts, names, dates) into bland summaries.
// The "ENTIRETY of memory" framing + an explicit preservation reminder
// keeps reflection from undoing the observer's detail-preservation work.
// Output schema unchanged (same line-based parseObservations contract).
export const REFLECTOR_PROMPT_TEMPLATE = `You are a reflection engine consolidating an agent's observation memory.

CRITICAL: your reflections are THE ENTIRETY of the agent's memory after this point. Any specific fact (number, name, date, quantity, identifier) that you fail to carry into the output is forever lost on subsequent turns. Treat consolidation as the last chance to save facts, not as gentle compression.

You will receive:
  - <Tier-2 observations, ordered by timestamp>

Rewrite the log:
  1. Merge related observations into single denser statements
  2. Drop outdated entries (those superseded by later, contradictory facts) — explicit state changes ("user moved from X to Y") signal which entries to drop
  3. Aggregate redundant details, preserving distinguishing entities
  4. Keep timestamps from the earliest contributing source observation

PRESERVE specifics verbatim while merging:
  - Numbers and quantities ("25 postcards", not "several postcards")
  - Proper nouns and names ("Luna", "Maria Garcia", not "the cat" / "a teammate")
  - Dates, times, durations
  - Identifiers (ticket IDs, file paths, URLs)
  - Specific locations ("under the bed", not "somewhere")

If two observations carry different specifics about the same topic, KEEP BOTH specifics in the merged line — don't pick one.
  BAD ❌  - 1700000000 (high) user mentioned hotel options
  GOOD ✅ - 1700000000 (high) user looking at hotels: Park Hyatt ($400/night, near station), Aman Tokyo ($1800/night, rooftop pool)

Target output size: ≤ 50% of input tokens.

Output format (one observation per line, same shape as the observer's output — the parser is strict about this):
- timestamp (high|med|low) factual statement
  - sub-detail (if any)
`
