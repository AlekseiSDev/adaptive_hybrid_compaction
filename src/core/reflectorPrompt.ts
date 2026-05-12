// Verbatim from `design/A_ahc-algorithm.md §8.2`. Reflector LLM compresses an
// existing Tier-2 observation log into a denser one (target ≤ 50% of input).
// Output uses the same `- timestamp (high|med|low) statement` bulleted form as
// the Observer (§4.2) so `parseObservations` round-trips.
export const REFLECTOR_PROMPT_TEMPLATE = `You are a reflection engine. Given a full observation log:
  - <Tier-2 observations, ordered by timestamp>

Rewrite it to:
  1. Merge related observations into single denser statements
  2. Drop outdated entries (those superseded by later, contradictory facts)
  3. Aggregate redundant details, preserving distinguishing entities
  4. Keep timestamps from the earliest contributing source observation

Target output size: ≤ 50% of input tokens.
Output format (one observation per line):
- timestamp (high|med|low) factual statement
  - sub-detail (if any)
`
