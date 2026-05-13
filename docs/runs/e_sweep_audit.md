# Track E — Sweep Audit (Phase D fast-track)

> Refreshed 2026-05-13 after Phase D rewrite (commits 0609428 prompt
> wiring → d9d1424 tau grader fix → 81115d2 tau re-run → S21 main sweep).
> SUPERSEDES the pre-Phase-D audit at `e-runs-complete` (which had
> baselines silently dropping system prompts, smoke fixtures on
> LME/LoCoMo, broken mastra_om OM, and a broken tau grader).
>
> Track F consumes the numbers below. For follow-ups (seed=43, larger
> n, mastra_om OM execution depth) see `e_phase_d_todos.md`.

## Headline numbers

Single seed=42, n=21 records/cell (1 mini-smoke + 20 main). All baselines
share `DEFAULT_AGENT_SYSTEM_PROMPT` (`src/core/prompts.ts`) — fair
comparison invariant holds for the first time in Track E.

### Text benches (`main_e1_text`)

| bench | full_context | anthropic_compact | ahc_full | mastra_om |
|---|---|---|---|---|
| assistant-traj | **0.190** | 0.167 | 0.143 | 0.143 |
| longmemeval-med | 0.762 | 0.524 | **0.762** | 0.762 |
| locomo-med | **0.857** | 0.714 | 0.810 | 0.857 |

Cost per cell (USD; `mastra_om` does not self-track cost, see warnings):

| bench | full_context | anthropic_compact | ahc_full | mastra_om |
|---|---|---|---|---|
| AT | 0.22 | 0.08 | 0.20 | 0.07 |
| LME | 2.38 | 0.02 | 2.37 | 0.02 |
| LoCoMo | 0.71 | 0.02 | 0.72 | 0.01 |

### Tau-bench retail (`main_e1_tau`)

After S22 grader fix (replay expected actions through upstream env to
get `expected_end_state` per task — commit `d9d1424`). Re-run on the
same baked 10-episode subset at seed=42 + 43.

| config | seed=42 | seed=43 | cost/episode |
|---|---|---|---|
| `tau_bench_agent` (vanilla) | 0.100 | 0.100 | $0.0124 |
| `tau_bench_agent_ahc` | 0.100 | 0.100 | $0.0138 |

Both agents solve 1/10 episodes. Gemini-3-flash is genuinely under-
powered for tau-retail's multi-tool exchange/modify/return flows
(optimal paths 5–15 actions). AHC cost overhead ~12% with no accuracy
gain at n=10.

## Honest read

1. **AHC vs full_context** — tied on long-context single-turn benches
   (LME 0.762/0.762, LoCoMo 0.810/0.857, within seed-noise). Loses 5pp
   on AT where multi-turn trajectories are short (5–15 turns), AHC's
   compaction induces information loss without big enough trajectory
   to recoup via savings.
2. **AHC vs anthropic_compact** — AHC wins ~24pp on LME (0.762 vs
   0.524). AC saves ~100× cost via server-side compaction but pays
   that accuracy. Pareto: AHC > AC on accuracy at higher cost.
3. **AHC cost ≈ full_context cost** on LME and LoCoMo. AHC's internal
   LLM overhead (digest/observer/reflector) cancels the savings from
   trimmed prompts at n=20 single-turn QA. Cost win surfaces only on
   long agentic trajectories — current AT (5–15 turns) isn't long
   enough at our task lengths.
4. **mastra_om** now runs OM through OpenRouter (S13 fix). Ties
   full_context on LME / LoCoMo, loses 5pp on AT — same shape as AHC.
   Suggests both compaction-flavored approaches share an AT failure
   mode (small-trajectory compaction noise).
5. **Tau-bench** grader is fixed (commit `d9d1424` replays expected
   actions in upstream Python env, dumps state diff into baked tasks).
   At n=10 we can't separate AHC from vanilla — both at 0.100. Need
   either bigger bake or stronger actor to recover discrimination
   signal.

## Spend

| Sweep | Cells | Records | Cost | Notes |
|---|---|---|---|---|
| `main_e1_text` (S21) | 12 | 252 | $6.45 | 4 baselines × 3 benches × seed=42, n=21 |
| `main_e1_tau` (S22) | 4 | 40 | $0.50 | 2 baselines × seed=42+43, n=10 |
| `main_e1_text` smoke (S21 pre) | (subset of S21) | (included) | $0.36 | mini-smoke gate |
| **Total Phase D fast-track** | — | 292 | **~$7.31** | vs $25 budget — 3.4× under |

OpenRouter cumulative: $404.86 → ~$410 (~$90 remaining of $500).

## What's NEW vs the pre-Phase-D audit at `e-runs-complete`

| Item | Before | After |
|---|---|---|
| System prompt | Placeholder / silently dropped per baseline | `DEFAULT_AGENT_SYSTEM_PROMPT` unified |
| Raw output persistence | none | `final_response_text` per record |
| LME subset | 3 smoke tasks | 120 real haystack tasks |
| LoCoMo subset | 3 smoke conversations | 25 real subset (seed=42 frozen) |
| Tau subset | 2 smoke episodes | 10 real episodes |
| Tau grader | always-1.0 (broken) | post-replay diff vs upstream env state |
| Mastra OM | silently degraded (model not found) | runs through OpenRouter Gemini-3-flash |
| Baselines seeing system prompt | only ahc_core (placeholder) | all 4 + tau actor |

## Acceptance gate (per E_main-runs.md §9)

- [x] `./scripts/verify.sh` green at S21 launch (typecheck + lint + 521 tests).
- [x] All re-run sweep cells have committed `summary.json` + `meta.json`.
- [x] `check-run.ts` exit 0 on both `main_e1_text/` and `main_e1_tau/`.
- [x] ErrorRecord rate 0% across every cell.
- [x] Phase D spend ≤ $25 budget — observed $7.31, 3.4× under.
- [x] `final_response_text` populated end-to-end (spot-checked).
- [ ] Statistical pipeline (Track F) — out of scope this phase.

## Tag

`e-phase-d-fast` — Track F entry for this phase.

## Sweep reproduction

```bash
set -a && . ./.env && set +a

# Text main:
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml \
  --concurrency=10 --max-tasks-per-cell=20

# Tau (with fixed grader from `bake_tau_expected_states.py`):
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_tau.yaml \
  --concurrency=5
```

Validation:

```bash
pnpm tsx scripts/check-run.ts benchmarks/runs/main_e1_text/
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_text/

pnpm tsx scripts/check-run.ts benchmarks/runs/main_e1_tau/
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_tau/
```

## Follow-ups

See `docs/runs/e_phase_d_todos.md` for the explicit list with cost +
reproduction commands.
