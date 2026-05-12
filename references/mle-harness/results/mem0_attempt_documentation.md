# Mem0 reproduction attempt — partial; not used as a head-to-head competitor

## What we tried
- Pinned `mem0ai==2.0.2` (recorded in `mle/results/mem0_version.json`).
- Configured Mem0 with `google/gemini-3-flash-preview` (via OpenRouter) as the LLM
  used for fact extraction and graph updates, and `text-embedding-3-large` (OpenAI)
  for vector storage.
- Per LongMemEval item we (a) reset the Mem0 user store, (b) ingested the
  haystack `haystack_sessions` turn-by-turn (so the user/assistant transcript
  was streamed exactly once), then (c) asked the question and graded with
  `gpt-4o-2024-08-06` using the same judge prompt as the rest of the sweep.

## What we got (partial, n=15 of the 50 in `mle/results/subset_A_ids.json`)
- 15 items completed end-to-end (ingest + answer + judge).
- **Accuracy = 10/15 = 0.6667** with our compatible-driver setup.
- Mean ingest wall-clock per item: **309.2 s ≈ 5.15 min**.
- Mean retrieved memory string at answer time: **~3.6k chars (~900 tokens)**.
- Mean driver-USD per answer (only the final compose call): **$0.00064**.

## What blocked completing 50/50
1. **Throughput.** At 5.15 min/item, finishing the remaining 35 items would
   need ≈3 h of wall-clock per re-run with little parallelism (Mem0's
   internal LLM calls bottleneck on its embedding+extract pipeline).
2. **Cost accounting hole.** Mem0's internal LLM calls go through its own
   client, NOT through our `LLMClient` proxy wrapper. The cost rows that
   show up in `mle/cost_log.jsonl` for Mem0 are **only the final answer
   compose** — they miss the per-fact extraction LLM calls Mem0 issues
   during ingest. Because each ingest involves dozens of internal calls
   over ~500 messages, the unlogged ingest spend is the dominant cost
   term, and we cannot reconcile it inside our $80 budget envelope.
3. **Risk of going over the cap.** With logged spend at **$59.44** at
   the time of writing, an additional 35 ingests at 5.15 min each
   (and unknown per-item burn) presents an unbounded budget risk.
   We chose to truncate at 15 and rely on published numbers for
   the head-to-head comparison.

## What we cite from the literature instead (with caveats)
- **arXiv 2504.19413** (Mem0 paper, 2025), Table 4 on LoCoMo: Mem0 = 66.88
  overall, Mem0g = 68.44, **driver = gpt-4o-mini** (their setup).
- **Mem0 research blog** (`research.mem0.ai/longmemeval`): Mem0 reports
  **93.4** on LongMemEval with an unspecified driver; the blog does not
  pin the driver model, retrieval k, or ingestion settings precisely.

These are reported as **`from_paper, driver-mismatch caveat`** in
`mle/results/pareto_data.json`, not as `competitor_run_by_us`.

## Honest framing for the paper
We cannot make a strict iso-conditions claim that "ours beats Mem0 head
to head". The qualitative comparison stands as:

> **Ours @ ~2k input tokens × 0.73 acc** (LongMemEval n=120, driver
> gemini-3-flash-preview)
> vs.
> **Mem0 paper claim @ ~7k retrieval tokens × 0.91 acc** (LongMemEval,
> driver unspecified — likely stronger).

Our **partial Mem0 run on the same 15-item slice with the same driver as
the rest of our sweep gives 0.667**, which is the most apples-to-apples
data point we have but it is too small a sample (n=15) to claim "ours
beats Mem0 at iso-driver"; it merely indicates the published 93.4
number is not directly transferable to a Gemini-3-Flash compose stage.

## Files
- `mle/results/mem0_main.jsonl` — 15 ingest + 15 answer rows.
- `mle/results/mem0_version.json` — pinned package version.
- `mle/cost_log.jsonl` — only contains the answer-compose calls; ingest
  calls are NOT in our log (Mem0 internal client).
