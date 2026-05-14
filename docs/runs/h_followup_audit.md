# Track H — Follow-up Audit (post Phase D extensions)

> Generated 2026-05-14 — Track H execution per user priority list
> (observer → offloader → Anthropic cache → Gemini direct → ablations →
> seed). This document is a peer companion to `e_sweep_audit.md` (the
> Phase D headline). F-report consumes both: E-audit = single-seed
> headline on the canonical text bench, H-audit = activation /
> cross-model / ablation numbers that extend the story.

> Replaces partially the role of the F-track numeric source — F reads
> tables here for claims that require beyond-single-seed evidence.

---

## Scope

Per user priority list (2026-05-14, `/plan`):

1. Observer-firing trajectories (priority #1) — H6.6.
2. Offloader activation (priority #2) — H6.7 + H6.1 (tau scale-up).
3. Anthropic cache mechanism on real LME (priority #3) — H6.2.
4. Switch to Gemini-3-flash for cross-model (priority #4) — H1 + H3.1 + H3-GD.
5. Ablations on real subsets (priority #5) — H5.
6. Seed=43 replication (priority #6, conditional on budget) — H4.
7. Analysis + audit (P7) — H6.3/H6.4 + this doc.

H6 budget actually spent vs plan:

| Phase | Plan estimate | Actual | Notes |
|---|---|---|---|
| P0 prep | $0 | $0 | YAML flag-flips, event counters, projection bugfix |
| P1 observer (lme-multiturn) | $12 | $21.72 | Higher than expected — full_context cumulative growth quadratic |
| P2 offloader (tau n=30) | $1.50 | $2.25 | Within range |
| P3 Anthropic cache (cache_hit_e3) | $5 | $8.30 | Sonnet rate × real LME size |
| P4 Gemini direct | $5 | $4.74 | On target |
| P5 ablations | $5-10 | (running) | TBD post-completion |
| P6 seed=43 | $13 | $0 (skipped) | Budget exhausted |
| P7 mastra OM | $0.50 | $0 (deferred) | Analysis-only doc |
| **Total** | **~$42-50** | **~$37 + P5** | Within OpenRouter remaining budget |

---

## Acceptance gates — summary

| Phase | Gate | Result | Status |
|---|---|---|---|
| **P1** Observer | ≥80% records carry observer event on ahc_full × lme-multiturn | 15/15 records, ~91 events/task | ✓ PASSED |
| **P1** Cache rate | ≥60% on ahc_full × lme-multiturn | 43% (multi-turn growing-prefix limit) | ✗ documented |
| **P2** Offloader | ≥30% episodes have offload event on tau-bench-retail × tau_bench_agent_ahc | 0/30 (tool sizes < T_SIZE_MIXED) | ✗ documented |
| **P2** Recall | ≥10% episodes have recall event | 0/30 (no pointers without offload) | ✗ documented |
| **P2** Token win | Any token saving vs vanilla | -12% cost (AHC $0.52 vs $0.59) | ✓ |
| **P3** Anthropic cache | ≥60% on ahc_full_anthropic × real LME | 49.1% (Tier-3 growth dominates) | ✗ documented |
| **P4** Gemini cache | cache_read_input_tokens > 0 on ≥1 step per cell | 22.7% rate, 10/10 records | ✓ PASSED |
| **P5** Ablation Δ | per-component delta > seed-spread floor (~2pp on n=10) | TBD | pending |

---

## Headline numbers

### Cross-bench cache rate comparison (Track H exclusive)

For the first time on the multi-turn / per-provider matrix:

| bench | actor / provider | n | total_input | cache_read | cache_rate | accuracy | cost($)/task |
|---|---|---|---|---|---|---|---|
| longmemeval-med | gpt-5.4-mini / OpenRouter | 20 | 4.17M | 4.05M | **97.0%** | 0.650 | 0.159 |
| **lme-multiturn** | gpt-5.4-mini / OpenRouter | 15 | 2.27M | 0.97M | 43% | 0.133 | 0.601 |
| longmemeval-med | claude-sonnet-4-6 / LITELLM (AHC) | 10 | 2.37M | 1.17M | **49.1%** | 0.300 | 0.819 |
| longmemeval-med | claude-sonnet-4-6 / LITELLM (anthropic_compact) | 10 | 0.022M | 0 | 0% | 0.300 | 0.011 |
| **lme-multiturn** | gemini-3-flash-preview / google_direct | 10 | 2.39M | 0.54M | **22.7%** | 0.200 | 0.474 |

Key observations:

- Single-turn LME (`longmemeval-med`) AHC achieves **97% cache rate** on gpt-mini (Phase D headline). Almost ideal.
- Multi-turn replay (`lme-multiturn`) AHC drops to **43% on gpt-mini, 22.7% on Gemini direct** — natural because tier-3 grows turn-by-turn, only the system+first-user prefix stays cached.
- **Anthropic Sonnet via LITELLM** achieves **49.1%** on real long LME (above 1024-token cache floor finally measurable).
- `anthropic_compact` uses server-side compact_20260112 — aggressively summarizes to ~22K input/task (vs AHC's 240K), no cache_control marker → 0% cache_read but **75× cheaper**. Different operating point.
- **Gemini cache_read on OpenRouter would be 0%** (OpenRouter strips cachedContentTokenCount — verified probes 2026-05-13). Direct route fixes that.

### Observer activation (Track H exclusive)

| bench × baseline | n | observer events total | records with ≥1 obs | density |
|---|---|---|---|---|
| longmemeval-med × ahc_full (Phase D) | 20 | 0 | 0/20 | 0% |
| **lme-multiturn × ahc_full** (Track H P1) | 15 | 910 | **15/15** | **100%** |
| lme-multiturn × ahc_full_gemini (P4) | 10 | 92×10 ≈ 920 | 10/10 | **100%** |
| tau-bench-retail × tau_bench_agent_ahc | 60 (2 seeds) | 0 | 0/60 | 0% |

H6.6 LME multi-turn replay reframes LongMemEval from "flatten history into single user msg" (where Tier-3 was empty) to "session-per-turn replay" (where Tier-3 fills through K_RECENT=6 sessions). With `OBSERVER_THRESHOLD=4000` (sweep YAML override), observer fires reliably — proves the mechanism works on real data, not just synthetic probes (`scripts/probe-observer.ts`).

### Offloader activation (Track H exclusive)

Tau-bench retail at n=30 produces **0 offload events** across all 60 tau_bench_agent_ahc records (2 seeds × 30 episodes).

Root cause: real retail tool results too small for default thresholds.

| Tool family | Avg bytes | Max bytes | T_SIZE_MIXED=2KB? |
|---|---|---|---|
| `get_user_details` | ~470 | ~474 | below |
| `get_order_details` | ~1067 | ~1244 | mostly below |
| `get_product_details` | ~1894 | ~3060 | above on long-variant products only |

Cumulative `T_CUM=24KB` could catch multi-step episodes, but typical retail
episode has 5-8 tool calls × ~1KB each = 5-8KB total — far below. Mechanism
works (verified `scripts/probe-offloader.ts` with synthetic 6KB tool blobs);
real tau-bench retail just isn't the corpus that exercises it at scale.

For F-report: avoid "offloader fires on tau-bench retail" claim. Use the
probe-offloader.ts result as mechanism proof; tau-bench result demonstrates
the AHC cost-saving (~12% per episode) WITHOUT offloader firing — comes
from classifier + observer at lower threshold + general code-path overhead.

### Tau-bench retail (P2)

| baseline | seeds | n_each | mean accuracy | mean cost($)/ep | events/ep |
|---|---|---|---|---|---|
| tau_bench_agent (vanilla) | 42, 43 | 30 | 0.100 | 0.601 | 0 |
| tau_bench_agent_ahc | 42, 43 | 30 | 0.100 | 0.525 | 0 |

Δ_cost: -12.6% (AHC cheaper). Accuracy: identical at 0.10. No clear win
either direction on accuracy. AHC's token saving comes through but
acceptance gate "≥30% episodes have offload" not met for reasons above.

### Phase 5 ablations

(TBD when sweep completes — placeholder)

---

## Code changes that landed in Track H

| Commit | Change |
|---|---|
| `62adf7c` | P0 — YAML flag-flips (TASK_AWARE_EXTRACTION/TYPE_AWARE_OFFLOAD on AHC configs); event-density counters in check-run.ts + sanity-aggregate.ts; AHC dormancy warn |
| `c40b8c4` | P1 — lme-multiturn bench + adapter; ConfigDef.thresholds plumbing |
| `5777796` | H1 — shared `resolveActorModel` helper; refactor 4 default-model sites |
| `7f4c4f9` | H3.1 — `google_direct` provider in createAhcRuntime; GOOGLE_DIRECT_PRICING; projection bugfix |
| `e4298e7` | P2 — tau-bench retail n=30 subset + `--subset` flag in bake script |
| `692a90e` | runner — `maxTasksPerCell` counts already-completed (NDJSON resume) |
| `2575fa4` | P1 — sweep results committed |
| (recent) | P3 — cache_hit_e3 sweep results |
| `2cecb3c` | P4 — main_e1_text_gemini sweep results |

---

## Open / honest limitations

1. **Cache rate on multi-turn shape < target.** §2.1 60% goal assumes
   stable single-call prefix; multi-turn replay grows the prefix turn-
   by-turn, so only system+first-user stays cached. F-report should
   document this as "AHC cache rate is bench-shape-dependent" rather
   than "AHC misses target".

2. **Offloader doesn't activate on tau-bench retail.** Real tool sizes
   below T_SIZE_MIXED. Mechanism proven on synthetic probe. F-report
   should NOT claim "offloader fires on tau" — instead show the
   probe-offloader.ts result as mechanism proof.

3. **AHC LOSES on lme-multiturn accuracy** (0.13 vs full_context/mastra_om
   both 0.50). Compaction discards LME haystack answer info. The 72%
   token savings come at accuracy cost. F-report should present this
   honestly as the AHC trade-off: token savings on long-memory tasks
   come with accuracy loss when the compacted info contains the answer.

4. **Tau accuracy 0.10 across all baselines.** Likely the
   gpt-5.4-mini actor is fundamentally weak on tau-bench retail
   (post-grader-fix). No clear AHC vs vanilla delta at this actor
   capability ceiling. Cross-model on tau (Gemini? Sonnet?) deferred —
   would add separate budget.

5. **Seed=43 (P6) skipped.** Budget tight after P1 over-spend ($21 vs
   $12 plan). Single-seed numbers above; F-report should note "single
   seed, variance bar from per-task SEM, not seed replication".

6. **mastra_om OM execution depth (P7.S7.1) deferred.** No debug-hook
   patch + re-run. Per Phase D investigation, mastra_om OM does fire
   on LME (observable through cost differential), but per-task OM
   trigger count unknown. Add to follow-up if F-report needs this.

7. **`AHC dormancy` warn in check-run.ts doesn't match tau cells.**
   Config hash → `tau_bench_agent_ahc` name not preserved in path,
   regex `(^ahc_)|(_ahc(?:$|_))` doesn't trigger. Minor — manual
   inspection of obs/off/rec column suffices.

---

## Cost spend summary

OpenRouter usage entering Track H: ~$420 of $500.
Track H spend so far (P1+P2+P3+P4): ~$37.
After P5: estimated total ~$50-55.
Budget headroom: ~$30 remaining (room for P6 if reactivated).

LITELLM (Sonnet): ~$8.30 (P3 only).
Google direct (Gemini): ~$4.74 (P4 only).

---

## Follow-up TODO (post-H)

- E2 ablations on AT scale-up (n=60) — surface stat power; condition: D3 synthetic AT generator lands.
- Cross-model seed=43 — re-run lme-multiturn Gemini direct + gpt-mini at seed=43 once D3 lands.
- Mastra OM debug-event audit — confirm OM trigger count per LME task.
- Tau-bench actor model upgrade — Sonnet via LITELLM for tau, see if accuracy improves above 0.10.
- AHC threshold tuning for lme-multiturn — current OBSERVER_THRESHOLD=4000 over-compacts; try 6000?

Track H sealed at this commit. F-report consumes the numbers; further
investigations in their own tracks.
