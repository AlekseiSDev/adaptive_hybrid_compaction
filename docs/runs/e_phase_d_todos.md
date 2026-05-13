# Phase D Follow-ups — TODOs for Track F (or whoever picks this up)

> Spawned from Phase D fast-track audit (`e_sweep_audit.md`, tag
> `e-phase-d-fast`). Each entry has: motivation, exact reproduction
> command, expected cost / wall-clock.

## 1. seed=43 replication on the main text sweep

**Why:** Phase D ran only seed=42 to compress wall-clock. F-track needs
seed=43 numbers to compute run-to-run variance + paired permutation
significance (`e_sweep_audit.md` quotes single-seed values without
spread bars).

**How:**

```bash
# Edit YAML in place:
sed -i.bak 's/seeds: \[42\]/seeds: [42, 43]/' eval/sweeps/main_e1_text.yaml

# Auto-resume: existing seed=42 cells stay; only seed=43 cells run.
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml \
  --concurrency=10 --max-tasks-per-cell=20
```

**Expected cost:** ~$6.50 (same as seed=42 — 12 fresh cells).
**Wall-clock:** ~10–15 min at conc=10.
**Output:** 12 additional cells under
`benchmarks/runs/main_e1_text/**/43/`.

## 2. Bump tau-bench subset (10 → 30+ episodes)

**Why:** at n=10 we can't separate AHC from vanilla (both 0.100). Need
30+ tau episodes for any meaningful accuracy delta with the seed-spread
floor we observe on text benches.

**How:**

```bash
# Pick 30 task_idxs from upstream tau-bench retail tasks_test (currently
# we have indices [3,13,14,17,28,31,35,81,86,94]). Edit
# references/mle-harness/results/taubench_episode_ids.json to extend the
# array, then re-bake:

source .venv-taubench/bin/activate
pnpm tsx scripts/bake-tau-bench.ts \
  /Users/Aleksei/Projects/adaptive_hybrid_compaction/.venv-taubench/lib/python3.14/site-packages/tau_bench/envs/retail
python scripts/bake_tau_expected_states.py  # patch expected_end_state

# Then re-run tau sweep
rm -rf benchmarks/runs/main_e1_tau/
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_tau.yaml \
  --concurrency=5
```

**Expected cost:** ~$1.50 (30 episodes × 2 baselines × 2 seeds × $0.013).
**Wall-clock:** ~10 min.

## 3. E2 ablations on real subsets

**Why:** existing `ablation_e2.yaml` was last run on smoke fixtures
(commits 1d7dac6 era). Re-run on real LME / AT subsets to surface AHC
component contributions now that the benches discriminate.

**How:**

```bash
rm -rf benchmarks/runs/ablation_e2/
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/ablation_e2.yaml \
  --concurrency=10 --max-tasks-per-cell=20
```

**Expected cost:** ~$10–15 (3 configs × 2 benches × 2 seeds × n=20).
**Wall-clock:** ~15 min.

## 4. E3 cache-rate verification on real LME

**Why:** §2.1 target is ≥60% cache_read on LME-med. Pre-Phase-D run
used smoke fixtures (3 tasks ~200 tokens — below Anthropic's 1024-token
ephemeral threshold so cache_read was 0). Real LME at ~16k tokens
should exercise the cache path.

**How:**

```bash
rm -rf benchmarks/runs/cache_hit_e3/
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/cache_hit_e3.yaml \
  --concurrency=5 --max-tasks-per-cell=20
```

**Expected cost:** ~$5 (Sonnet via LITELLM, n=20 × 2 cells).
**Wall-clock:** ~10 min.

## 5. mastra_om OM execution depth audit

**Why:** S13 fix wired OM to OpenRouter Gemini-3-flash, but we have not
confirmed OM thresholds actually fire on real LME haystack inputs (the
default trigger is 30k message tokens; some LME tasks have ~106k input).
The mastra_om = full_context tie on LME could mean OM is firing but not
helping, OR OM is never triggered.

**How:**

```ts
// src/eval/baselines/mastra_om.ts — buildMemoryOptions(deps):
options: {
  observationalMemory: {
    model: resolveMastraModel(deps),
    onDebugEvent: (event) => {
      console.log(`[mastra:om] ${event.type} tokens=${event.pendingTokens}`)
    },
  },
}
```

Re-run mastra_om cells; tail logs for `observation_triggered` events.
If zero on LME → bump threshold or surface as paper caveat.

**Expected cost:** ~$0.50 (just mastra_om × 3 benches × 1 seed × n=20).

## 6. AT loss investigation (AHC -5pp vs full_context)

**Why:** mastra_om and ahc_full both lose 5pp on AT (0.143 vs FC 0.190).
Could be: (a) compaction-induced info loss on multi-turn AT, (b)
classifier mis-categorising AT trajectories, (c) image-modal handling
asymmetry between baselines (FC passes images via OpenRouter; AHC might
drop them in Tier-2 summary).

**How (investigation, not a sweep):**

```bash
# Per-class breakdown on AT records:
pnpm tsx scripts/per-class-report.ts \
  benchmarks/runs/main_e1_text/assistant-traj/79f4236224fc1922/42/records.ndjson

# Compare to full_context (17e02d3b...) for same task_ids → diff
# accuracy by category (code_iter / image_qa / research_write / mixed).
```

If image_qa shows the biggest AHC-vs-FC gap, investigate Tier-2
content for image-bearing turns. Otherwise look at compaction events
on losing tasks.

## 7. Larger AT subset

**Why:** AT has only 30 baked tasks. With seed-spread ~2pp and small
ablation deltas, we want n≥60 for paper-grade statistics. Track D3
synthetic generation was deferred (real + OSS = 30, gate met).

**How:** new bake script `scripts/generate-assistant-traj.ts` that uses
LLM (Sonnet-4.6) to extend the 30 hand-curated tasks with ~30 synthetic
ones at matching distribution (8 code_iter, 8 image_qa, 7 research_
write, 7 mixed). Each synthetic task needs `provenance.review_signoff`
per design `D_assistant-traj.md §3.3`. Estimate ~$1 to generate.

This is the only entry that requires NEW CODE rather than a sweep run.

## Spend budget for all follow-ups combined

| TODO | Cost |
|---|---|
| 1 seed=43 main text | $6.50 |
| 2 tau n=30 | $1.50 |
| 3 E2 ablations | $10–15 |
| 4 E3 cache rate | $5 |
| 5 mastra OM audit | $0.50 |
| 6 AT investigation | $0 (analysis only) |
| 7 AT synthetic gen | $1 |
| **Total** | **~$25–30** |

OpenRouter remaining: ~$90 of $500. All follow-ups fit comfortably
within the remaining budget.
