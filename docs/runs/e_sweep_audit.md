# Track E — Sweep Audit (Phase D fast-track, gpt-5.4-mini re-run)

> Refreshed 2026-05-13 (commit `5892063` model-defaults swap → re-run of
> S21 sweep on `openai/gpt-5.4-mini`). SUPERSEDES the prior fast-track
> entry which was silently executed on `google/gemini-3-flash-preview`
> (defaults swap was docs-only in `decisions.md`; code constants were
> not updated until `5892063`).
>
> Track F consumes the numbers below. Follow-up runs (cross-model,
> seed=43, ablations, scale-up) live in
> [`docs/design/H_ablations_and_TODOs.md`](../design/H_ablations_and_TODOs.md).
>
> **Competitor baseline numbers** (`full_context`, `anthropic_compact`,
> `mastra_om`) — canonical в [`baselines_frozen.md`](baselines_frozen.md).
> Future sweeps re-use frozen — competitor cells не перегоняются.
> Этот audit-doc — исторический snapshot Phase D, frozen file его
> цитирует.

---

## Headline numbers

Seed=42, n=20 records/cell. Actor model `openai/gpt-5.4-mini`
(OpenRouter, auto-cache). LLM judge `claude-sonnet-4-6` via LITELLM
for `assistant-traj`; benchmark-specific scoring for LongMemEval /
LoCoMo. All baselines share `DEFAULT_AGENT_SYSTEM_PROMPT`
(`src/core/prompts.ts`) — fair-comparison invariant.

| bench | baseline | n | input_tok | cache_read | cache% | acc | actor_$ | judge_$ | total_$ |
|---|---|---|---|---|---|---|---|---|---|
| assistant-traj | full_context | 20 | 89 823 | 31 232 | 34.7% | 0.200 | 0.192 | 0.086 | 0.278 |
| assistant-traj | anthropic_compact | 20 | 141 291 | 0 | 0% | **0.225** | n/a* | 0.092 | 0.092 |
| assistant-traj | mastra_om | 20 | 87 429 | 25 088 | 28.6% | 0.200 | n/a* | 0.084 | 0.084 |
| assistant-traj | ahc_full | 20 | 78 435 | 9 728 | 12.4% | 0.200 | 0.183 | 0.083 | 0.266 |
| longmemeval-med | full_context | 20 | 4 173 716 | 1 562 368 | 37.4% | 0.650 | 3.175 | 0.015 | 3.189 |
| longmemeval-med | anthropic_compact | 20 | 42 220 | 0 | 0% | 0.650 | n/a* | 0.020 | 0.020 |
| longmemeval-med | mastra_om | 20 | 4 170 616 | 3 832 576 | 91.8% | **0.700** | n/a* | 0.013 | 0.013 |
| longmemeval-med | ahc_full | 20 | 4 169 490 | 4 046 592 | **97.0%** | 0.650 | 3.153 | 0.015 | 3.168 |
| locomo-med | full_context | 20 | 1 119 694 | 774 144 | 69.1% | 0.600 | 0.853 | 0.011 | 0.864 |
| locomo-med | anthropic_compact | 20 | 1 294 774 | 0 | 0% | 0.600 | n/a* | 0.015 | 0.015 |
| locomo-med | mastra_om | 20 | 1 119 349 | 1 048 064 | 93.6% | 0.600 | n/a* | 0.011 | 0.011 |
| locomo-med | ahc_full | 20 | 1 119 277 | 1 105 920 | **98.8%** | 0.600 | 0.851 | 0.010 | 0.862 |
| lme-multiturn ✠ | full_context | 10 | 28 376 258 | 25 596 416 | **90.2%** | 0.500 | 21.711 | 0.007 | 21.718 |
| lme-multiturn ✠ | anthropic_compact | — | — | — | — | — | — | — | — |
| lme-multiturn ✠ | mastra_om | 10 | 9 344 594 | 7 235 584 | 77.4% | 0.500 | 4.738 | 0.008 | 4.746 |
| lme-multiturn ✠ | ahc_full | 15 | 3 548 449 | 1 530 368 | 43.1% | 0.133 | 9.000 | 0.012 | 9.012 |

✠ `lme-multiturn` cells run in Track H Phase 1 (commit `c40b8c4`, sealed
post-Phase-D), NOT part of the original Phase D fast-track sweep. Added here
for one-table cross-bench glance per user request. Authoritative source:
[`h_followup_audit.md §Headline numbers`](h_followup_audit.md#headline-numbers).
`anthropic_compact` not run on `lme-multiturn`.

**n divergence**: cell n is 10 (FC, mastra_om) / 15 (ahc_full) because
sweep YAML hit `budget_usd=40` halt — FC × lme-multiturn costs ~$2.17/task
(quadratic cumulative history across 47-session replay), so n=15 across all
3 cells would have exceeded the cap. Cheap-first config ordering (ahc_full
first per YAML comment) ensured ahc reached n=15 before halt.

**Numbers re-aggregated 2026-05-22** via `pnpm tsx scripts/sanity-aggregate.ts
benchmarks/runs/main_e1_text_lme_mt/` (token/cache columns added that day —
see `scripts/sanity-aggregate.ts`). Supersedes earlier h_followup_audit values
of `2.27M / 0.97M` for ahc_full × lme-mt input/cache (cache% unchanged at
43%; absolute totals were under-reported in h_followup-headline; cost/task
$0.601 still matches).

**mastra_om actor cost is bubbled here** — unlike Phase D rows above where
mastra_om / anthropic_compact were marked `n/a*`. The `mastra_om` baseline
last touched `5777796` (post-Phase-D), which restored Mastra-side cost
bubbling. `anthropic_compact` cost bubbling status unchanged (still
LITELLM-routed, still n/a).

*`n/a` actor cost: `mastra_om` and `anthropic_compact` do not bubble
provider-side cost back to our `RunRecord` (Mastra owns its own LLM
call; `anthropic_compact` uses LITELLM forwarder which currently
isn't priced in `OPENROUTER_PRICING`). Token counts are accurate;
F-report should back-fill cost from `(input_tok × pricing.input +
output_tok × pricing.output)` using `OPENROUTER_PRICING` (gpt-5.4-mini
input $0.75/M, output $4.50/M) or the LITELLM Sonnet pricing for
`anthropic_compact`.

**Sweep totals:** 12 cells, 240 records, $8.86 spend ($90 budget cap
unused). Wall-clock 13 min at conc=10.

## Key findings

### 1. Cache target §2.1 ≥60% — VERIFIED on long-context benches

For the first time on the main sweep (vs prior smoke fixtures where
input < 1024-token auto-cache floor), AHC's cache hit rate is
empirically measured:

- **LongMemEval:** ahc_full 97.0% cache hits (vs full_context 37.4%).
- **LoCoMo:** ahc_full 98.8% cache hits (vs full_context 69.1%).
- AHC cache rate **doubles to triples** full_context's, hitting the
  §2.1 ≥60% target with significant margin.

This is the cleanest live signal that AHC's stable Tier-1 prefix +
gpt-5.4-mini OpenRouter auto-cache (no `cache_control` markers needed)
works as designed.

### 2. AssistantTraj — AHC cache rate INVERTED (12.4% < FC 34.7%)

On AT (5-15 turn agentic trajectories) AHC's cache rate is **lower**
than full_context. Likely root cause: AHC's compaction churns the
prefix (Tier-2 scratchpad mutations) → stable cache prefix breaks
between turns; full_context replays history unchanged, so OpenRouter
sees the same prefix and caches it. Same effect was visible in design
predictions but quantified for first time here.

Net cost effect: AHC saves only $0.012 (4%) vs FC on AT — because
fewer input tokens (78K vs 90K) is mostly offset by cache loss.
Accuracy identical (both 0.200). **AHC's compaction is mostly a wash
on AT at n=20.**

Investigation hook: §H6.3 of `H_ablations_and_TODOs.md` —
`scripts/per-class-report.ts` breakdown by AT class (code_iter /
image_qa / research_write / mixed) will show where AHC loses cache
predictability.

### 3. anthropic_compact massively under-uses tokens on LongMemEval

42K input tokens vs 4.17M for all 3 other baselines on the same 20
LME tasks. anthropic_compact aggressively summarises the haystack
before sending, retaining same accuracy (0.650). This is a strong
external compaction baseline — F-report should highlight that on
LME-med, `anthropic_compact` ≈ same accuracy at ~1% the input
cost (cost back-fill needed).

### 4. mastra_om +5pp on LongMemEval over others

mastra_om hits 0.700 on LME vs 0.650 for the other three (all on
identical baked tasks, same actor model). This is a meaningful but
single-seed signal. Should re-check at seed=43 (H4) before claiming
as a robust result — could be variance on n=20.

### 5. AHC vs full_context — accuracy flat on text benches

Every (bench, baseline) pair tied within ±2.5pp at n=20:

- AT: ahc_full 0.200 = full_context 0.200
- LME: ahc_full 0.650 = full_context 0.650
- LoCoMo: ahc_full 0.600 = full_context 0.600

This is **consistent with AHC's design** (passive-recall benches:
classifier should route long-input tasks to a tier strategy that
preserves full context; AHC's value-add lives in cache hit rate, not
token reduction here). The accuracy-equivalence story holds; the
cache-rate story is the win.

## What's new vs pre-`5892063` (Gemini) run

| Aspect | pre-`5892063` (Gemini-3-flash) | post-`5892063` (gpt-5.4-mini) |
|---|---|---|
| `actor_cost / predicted_<target>` | matched gemini-3-flash pricing | matches gpt-5.4-mini pricing (sub-agent verified, ratio = 1.0000) |
| `cache_read_input_tokens` per record | null / 0 (Gemini-3 OpenRouter no auto-cache) | populated; 97/99% on LME/LoCoMo for ahc_full |
| Cache target §2.1 verification | impossible (no cache fired) | passed with margin |
| Headline cost | comparable (~$7) | $8.86 |
| Headline accuracy | similar | similar |

## Validity gates (`scripts/check-run.ts`)

- 0 errors, 28 warnings.
- Warnings split:
  - **24** records: `cost_usd=0` on `anthropic_compact` / `mastra_om`
    cells (LITELLM / Mastra don't bubble cost — see *n/a* footnote).
    F-report back-fill required.
  - **4** records: AT image_qa tasks judged without `judge_explanation`
    populated. Inspection shows judge returned binary score with
    score-only return path. Same pattern in pre-Phase-D runs;
    pre-existing, not introduced this sweep.

All `summary.json.status == 'complete'`, no `ErrorRecord` rate > 0%.

## Known caveats for F-report

1. **n=20 per cell** — single-seed. Variance bars require H4 (seed=43).
2. **No cross-model comparison** — only gpt-5.4-mini. Cross-model
   honest story needs H1 (env-override hardening, blocked) + H3 (Gemini
   re-run). Without this, F-report claims must be scoped «on
   gpt-5.4-mini OpenRouter setup with auto-cache».
3. **anthropic_compact / mastra_om actor cost** — back-fill from tokens.
4. **AHC vs full_context accuracy tie** — expected by design (passive
   recall benches keep full context); paper headline focuses on cache
   rate × cost frontier, not raw accuracy.
5. **Tau-bench** — NOT included in this sweep (separate `main_e1_tau`
   dir, grader was fixed `d9d1424` but n=10 still too small for
   discrimination → see H6.1). Update Track I (2026-05-22): cross-framework
   competitor `mastra-agent` теперь runs на tau-bench-retail-med — see
   `docs/runs/i_mastra_agent_audit.md`.

## Reproduction

```bash
# Single command, after `set -a && . ./.env && set +a`:
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml \
  --concurrency=10 --max-tasks-per-cell=20
# 13 min wall-clock, $8.86 spend, 240 records.
# Re-run idempotent via NDJSON skip; delete a cell dir to force re-run.
```

## Tag

`git tag e-phase-d-gpt5.4-mini` (parallel to `e-phase-d-fast` which
points to the now-superseded Gemini run; that tag is preserved for
audit trail but its records were not regenerated).
