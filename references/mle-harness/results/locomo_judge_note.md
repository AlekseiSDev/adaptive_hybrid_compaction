# LoCoMo evaluation: documented deviation from per-type metrics

## What we did
- Dataset: `Percena/locomo-mc10` (HuggingFace mirror of `snap-research/locomo10`),
  10 conversations, ~17.5k tokens each, ~1986 QA pairs across 5 categories.
- Sample: 25 items stratified across 4 categories (1=single-hop, 2=multi-hop,
  3=temporal, 4=open-domain), seed=42; **category 5 (adversarial / unanswerable)
  was excluded** because it requires a separate "abstain correctness"
  judge prompt.
- Driver / compactor: `google/gemini-3-flash-preview` (same as LongMemEval main).
- Compaction budget: 8000 tokens.
- Strategies: `rolling_summary`, `type_aware`, `task_aware`.

## Judge: simplified canonical-LLM-Judge variant
The original LoCoMo paper uses **per-category metrics** — e.g. F1/SR for
single-hop, exact-match-with-tolerance for temporal, an LLM-Judge for
open-domain. We deliberately deviated from this and used **one unified
LLM-Judge prompt across all four task types**:

> "I will give you a question, a correct answer, and a response from a
> model. Please answer yes if the response matches the correct answer
> with reasonable equivalence allowed. The response is correct if it
> conveys the same factual content, even if the wording differs.
> Otherwise, answer no."

Judge model: `openai/gpt-4o-2024-08-06`, temperature=0, max_tokens=10.

### Why
- Our headline contribution is **inter-strategy comparison**, not
  per-category absolute numbers. A single judge prompt yields a
  consistent metric across all 4 categories, which is sufficient for
  the relative claim ("task_aware > rolling > type_aware on LoCoMo").
- Using gpt-4o as judge keeps LoCoMo numbers comparable to our
  LongMemEval numbers (same judge, same scoring policy).
- We are NOT claiming to reproduce the exact LoCoMo headline numbers
  from the original paper — and our numbers should not be compared
  one-to-one against papers that report F1 / SR.

### Caveat
- "Reasonable equivalence" is judge-model-dependent. We tested only
  gpt-4o-2024-08-06; a stricter exact-match metric would yield lower
  absolute numbers but is unlikely to change the ranking, given the
  large between-strategy gaps we observe (task_aware=0.84 vs
  rolling=0.44 vs type_aware=0.36 at n=25).

## Files produced
- `mle/results/locomo_main.jsonl` — 75 rows (25 items × 3 strategies)
- `mle/results/locomo_summary.json` — per-strategy + per-type breakdown
- `mle/results/locomo_subset_ids.json` — the 25 sampled item IDs
- `mle/data/locomo/locomo10.json` — local copy of the dataset
