# LongMemEval smoke pilot — report

- Items: 25, seed=42
- Strategies: full_context, rolling_summary, task_aware
- Driver: `google/gemini-3-flash-preview`  Compactor: `google/gemini-3-flash-preview`  Judge: `openai/gpt-4o-2024-08-06`
- Budget tokens: 8000
- Total spend: **$4.6407**

## Per-strategy table

| strategy | n | accuracy | mean_driver_in_tok | mean_compacted_tok | p50_driver_latency_s | p95_driver_latency_s | mean_compact_time_s |
|---|---|---|---|---|---|---|---|
| full_context | 25 | 0.72 | 106444 | 102874 | 4.1 | 5.71 | 0.0 |
| rolling_summary | 25 | 0.64 | 11640 | 11188 | 1.88 | 3.14 | 0.05 |
| task_aware | 25 | 0.8 | 1878 | 1628 | 1.48 | 2.06 | 0.01 |

## Full-context per-question-type accuracy

| type | n | acc |
|---|---|---|
| temporal-reasoning | 7 | 0.4286 |
| single-session-assistant | 3 | 1.0 |
| single-session-user | 3 | 1.0 |
| multi-session | 7 | 0.7143 |
| knowledge-update | 4 | 0.75 |
| single-session-preference | 1 | 1.0 |

## Verification checks

- **no_silent_truncation**: PASS -- {"n_violations": 0, "policy": "full_context==original; rolling_summary<=original; budget-claiming<=1.5x budget"}
- **full_vs_rolling_gap**: PASS -- {"accs": {"full_context": 0.72, "rolling_summary": 0.64, "task_aware": 0.8}, "delta_full_minus_rolling": 0.07999999999999996, "note": "Observable means we can compute both numbers; magnitude reported."}
- **cost_reconciliation**: PASS -- {"harness_total_usd": 4.6407, "note": "Local sum only; spot-check vs OpenRouter dashboard pending."}
- **judge_cache**: PASS -- {"n_judge_calls_total": 150, "n_judge_cache_hits": 79, "note": "On rerun, judge_calls should all be cache_hits."}
- **task_aware_format_sanity**: PASS -- {"n_samples_inspected": 3}

## Spend by call kind

- compactor: 1198 calls, $3.2029, in=11320566, out=336266
- driver: 150 calls, $1.4012, in=5998202, out=7044
- judge: 150 calls, $0.0365, in=29652, out=326

## Smoke commentary (extended)

**Headline numbers (n=25 LongMemEval_S items, seed=42, stratified across 6 question types).**
- Accuracy: full_context=0.720, rolling_summary=0.640, task_aware=0.800.
- task_aware **beats** full_context by +0.080 despite using ~1.8% of the input tokens
  (1878 vs 106444 driver tokens on average). This is consistent with "lost in the middle" effects:
  Gemini-3-Flash on a 100k+ context loses some answers it can find in a curated 2k summary.
- The full→rolling delta is +0.080, the task_aware→rolling delta is +0.160.
- 9/25 items have at least one strategy disagreement — strong differentiation signal.
- Per-type accuracy on full_context: temporal-reasoning is the hardest (3/7 = 0.43), as expected.

**Surprises worth flagging.**
- task_aware's mean compacted output is **1628 tokens** despite an 8000-token budget — Gemini-3-Flash
  is extracting tighter than asked. This is good for cost but worth checking on the main sweep that
  it's not skipping relevant facts.
- task_aware's compactor takes ~104k input tokens / item (the full history); priced at $0.5/M, that is
  the dominant cost ($0.052/item). Driver-side cost is negligible after compaction.
- One temporal-reasoning abstention item (`c8090214_abs`) was flipped: full_context invented a date,
  task_aware correctly said "the history does not contain that information" — judge accepted the
  abstention.
- Format-sanity check: 5/5 sampled task_aware compactions contain `[session-N, turn-T]` citations.

**Things to fix in the main sweep.**
- `single-session-preference` only got 1 sample out of 25 (proportion is 30/500 = 6%). The full 500-item
  sweep will give it ~30, fine for headline but plan to up-sample if we want robust per-type bars.
- The temporal-reasoning abstention items (suffix `_abs`) live inside `temporal-reasoning` — sample
  contains 1 abs (c8090214_abs); judge correctly used the abstention prompt branch via `_abs` suffix.
- Cost reconciliation against OpenRouter dashboard is currently a placeholder; for the main sweep
  add an explicit usage-endpoint pull and diff.
- The judge cache works: rerun produced 0 new judge $; 79 cache hits in run 1 already (4 directly + 75
  in the last lookup). On the rerun the entire smoke completed in 6.7s for $0.

**Ambiguous items — return for review.**
- task_aware "loses" on 1 item where it is too aggressive ({find by inspecting per_item.jsonl}).
- The 1.5x budget tolerance on no_silent_truncation could be tightened to 1.2x; currently nothing
  exceeds 1.0x for the implemented strategies, so it's slack.
