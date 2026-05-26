# Frozen competitor baselines

Числа конкурентов (`full_context`, `mastra_om`, `anthropic_compact`,
`tau_bench_agent` vanilla) — здесь, чтобы не перегонять при каждом sweep.
AHC-числа итерируются, живут в `e_sweep_audit.md` / `h_followup_audit.md`.

Все цифры — `pnpm tsx scripts/sanity-aggregate.ts <run-dir>` over
`benchmarks/runs/{main_e1_text, main_e1_text_lme_mt, main_e1_tau,
cache_hit_e3}/` (gitignored). Actor = `gpt-5.4-mini` через OpenRouter если
не указано иначе. seed=42.

## Text benches

| bench | baseline | n | input_tok | cache% | acc | total_$ |
|---|---|---|---|---|---|---|
| assistant-traj | full_context | 20 | 89 823 | 34.7% | 0.200 | 0.278 |
| assistant-traj | anthropic_compact | 20 | 141 291 | 0% | 0.225 | 0.092 |
| assistant-traj | mastra_om | 20 | 87 429 | 28.6% | 0.200 | 0.084 |
| longmemeval-med | full_context | 20 | 4 173 716 | 37.4% | 0.650 | 3.189 |
| longmemeval-med | anthropic_compact | 20 | 42 220 | 0% | 0.650 | 0.020 |
| longmemeval-med | mastra_om | 20 | 4 170 616 | 91.8% | 0.700 | 0.013 |
| longmemeval-med | anthropic_compact (Sonnet/LITELLM) | 10 | 22 000 | 0% | 0.300 | 0.011 |
| locomo-med | full_context | 20 | 1 119 694 | 69.1% | 0.600 | 0.864 |
| locomo-med | anthropic_compact | 20 | 1 294 774 | 0% | 0.600 | 0.015 |
| locomo-med | mastra_om | 20 | 1 119 349 | 93.6% | 0.600 | 0.011 |
| lme-multiturn | full_context | 10 | 28 376 258 | 90.2% | 0.500 | 21.718 |
| lme-multiturn | mastra_om | 10 | 9 344 594 | 77.4% | 0.500 | 4.746 |
| lme-multiturn | anthropic_compact | — | — | — | — | — (not run) |
| assistant-traj | mastra-agent ✠ | 30 | 164 005 | 42.8% | 0.283 | 0.580 |
| lme-multiturn | mastra-agent ✠ | 40 ⚠ | 37 859 704 | 70.7% | 0.475 | 20.174 |

✠ Track I baseline (2026-05-22). Source: `docs/runs/i_mastra_agent_audit.md`.
⚠ `lme-multiturn × mastra-agent` partial cell — budget halted после n=40
(`main_e1_mastra_agent.yaml budget_usd=35`). Tau cell split в отдельный
`main_e1_mastra_agent_tau.yaml` — см. tau-bench retail table ниже.

### gaia-med (Track K + K-tail, 2026-05-26, finalized после Mastra threshold tuning)

`main_e1_gaia_competitors.yaml` × n=25 × seed=42 × `gpt-5.4-mini` (OpenRouter),
SearXNG via `observability/searxng-docker-compose.yml`. Source:
`docs/runs/k_gaia_audit.md`.

**Naming note**: на agentic bench "FC analog" = `gaia_bench_agent` (vanilla
actor с tools, без AHC middleware) — literal `full_context` baseline без tools
degenerate (~5-15% expected). Все три baseline ниже используют те же 5 GAIA tools
через SearXNG; различаются compaction layer.

| bench | baseline | n | input_tok | acc | cost_$ | $/task |
|---|---|---|---|---|---|---|
| gaia-med | gaia_bench_agent (FC analog) | 25 | 1 715 589 | 0.320 | 1.347 | 0.054 |
| gaia-med | mastra-agent ✠ | 25 | 3 180 785 | **0.400** | 2.465 | 0.099 |
| gaia-med | gaia_bench_agent_ahc ✠✠ | 25 | 804 480 | 0.200 | 0.871 | 0.035 |

✠ Track K-tail (2026-05-26): Mastra Agent + Memory + LibSQL + GAIA tools.
Required two fixes:
1. **maxSteps cap** — Mastra `agent.generate(messages, {maxSteps: 20})` returns
   empty `result.text` if last step was tool_call awaiting result. Bumped к 40
   (`src/eval/adapters/gaia-med/mastra-agent-runner.ts:DEFAULT_MAX_STEPS`).
   Без fix'а: 9/25 tasks empty, acc=0.160.
2. **Memory thresholds** — Mastra observationalMemory defaults
   `observation.messageTokens: 30 000` / `reflection.observationTokens: 40 000`
   (per `node_modules/@mastra/memory/dist/chunk-LSJJAJAF.js`
   OBSERVATIONAL_MEMORY_DEFAULTS). На GAIA multi-tool tasks input 60-95K —
   Observer fired aggressively, erasing useful tool_results. Bumped к
   100K/200K (К-tail-2). acc 0.28 → **0.40**, empty 4/25 → 1/25, cap-hits 4 → 1.

**Mastra (0.40) > FC analog (0.32)** на этом setup — Memory effective с raised
thresholds. Cost penalty $2.47 vs $1.35 (1.8×) приемлем для +25% accuracy.

Per-level (1/2/3): FC analog 4/7 + 4/14 + 0/4; mastra 4/7 + **6/14** + 0/4;
AHC 3/7 + 2/14 + 0/4. Mastra +3 tasks на L2 vs FC analog; AHC −2 tasks
vs FC analog despite raised observer/reflector — see ✠✠ note.

✠✠ AHC variant (К-tail-2, `main_e1_gaia_ahc.yaml`): `OBSERVER_THRESHOLD=100K`,
`REFLECTION_THRESHOLD=200K`, `TIER3_TOKEN_BUDGET=100K`. **Не тюнили** другие
thresholds: `T_SIZE=4096` (tool-result offload), `T_CUM=24000`, `K_RECENT=6`.
Web search tool_results (20-50K chars) сразу offload'ятся в scratchpad через
Type-Aware Offloader — actor теряет search context на следующем step'е.
Input всего 804K (vs FC analog 1.72M, Mastra 3.18M) — AHC компактит
самым агрессивным slice'ом. Полный AHC threshold-sweep (`T_SIZE` +
`T_CUM` тоже raised) — отдельный run.

Mastra opaque to Langfuse (`@mastra/core` doesn't expose `experimental_telemetry`
option). Diagnostic via `Score.secondary.n_tool_calls` (К-tail instrumentation):
Mastra 346 tools / 25 tasks = 13.8/task; FC analog 358 tools / 25 = 14.3/task.
Comparable tool-call rate.

Effective n=25 (5/30 attachment tasks filtered at bake — xlsx/pdf/pdb/jsonld/docx
not vendored).

Caveats:
- `lme-multiturn` — наше расширение upstream (см. `docs/benchmarks.md §2`);
  budget halt урезал FC/mastra до n=10, anthropic_compact не гоняли.
- `mastra_om` actor cost **не bubble** на Phase D строках (assistant-traj,
  longmemeval-med, locomo-med) — `total_$` там = только judge. Backfill
  через `OPENROUTER_PRICING` (input $0.75/M, output $4.50/M). На
  lme-multiturn (commit `5777796`+) actor cost ЕСТЬ — `total_$` полный.
- `anthropic_compact` actor cost тоже не bubble (LITELLM forwarder) —
  backfill тем же способом.

## AT corpus version note (Track J — 2026-05-22)

- **AT-v1** (n=30, text-only) — numbers above для `assistant-traj` rows valid
  до 2026-05-22. AT-v1 30 task files retired в Track J3 (`git rm` 9 of 30; 21
  overwritten by AT-v2 drafts на same `at_<cat>_NNN.json` paths). Git history
  preserves AT-v1 content; current `benchmarks/assistant_traj/tasks/` is AT-v2.
- **AT-v2** (n=50, tool-grounded) — current corpus. Per-baseline numbers will
  be regenerated in a J6 follow-up sweep (single seed, smoke budget). See
  `docs/runs/at_v2_baselines.md` for the new snapshot once the sweep lands.
- **AT-v2 draft status**: tasks are jay-canvas-seeded (21) + synthetic top-up
  (29); per-task `provenance.review_signoff` carries `<draft>` markers
  pending manual hand-extension to 5–15 turns + real fixture capture
  (`scripts/capture-at-fixture.ts` — J2/J4 stretch, requires live API).

## Tau-bench retail

| baseline | n (pooled seeds) | acc | cost_$/episode | mean tool_calls/episode |
|---|---|---|---|---|
| tau_bench_agent (vanilla) | 60 | 0.100 | 0.601 | — (frozen pre-mean) |
| mastra-agent ✠ | 30 | 0.100 | **0.036** | 6.1 |

(vanilla seeds=42,43, n=30 на seed; mastra-agent seed=42 only, n=30.)
✠ Track I (2026-05-22). 17× cheaper per-episode than vanilla на той же
accuracy — Mastra Memory compactit history между turn'ами (implicit
compaction). 100% episodes имеют ≥1 tool call. cache_read=0 (Mastra Memory
injection breaks OpenRouter auto-cache на multi-turn alternation). Source:
`docs/runs/i_mastra_agent_audit.md §2`.
