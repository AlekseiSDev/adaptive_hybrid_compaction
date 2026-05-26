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

✠ Track I baseline (2026-05-22).
⚠ `lme-multiturn × mastra-agent` partial cell — budget halted после n=40
(`main_e1_mastra_agent.yaml budget_usd=35`). Tau cell split в отдельный
`main_e1_mastra_agent_tau.yaml` — см. tau-bench retail table ниже.

### gaia-med (Track K + K-tail, 2026-05-26, finalized после Mastra threshold tuning)

`main_e1_gaia_competitors.yaml` × n=25 × seed=42 × `gpt-5.4-mini` (OpenRouter),
SearXNG via `observability/searxng-docker-compose.yml`.

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
Input всего 804K (vs gaia_bench_agent 1.72M, Mastra 3.18M) — AHC компактит
самым агрессивным slice'ом. AHC underperforms vanilla (0.20 vs 0.32) именно
по этой причине — дополнительные compaction layers стрелют по полезному
context'у.

**К-tail-3 deferred.** Полный AHC threshold-sweep (T_SIZE→50K, T_CUM→200K,
K_RECENT→20) ожидаемо подтянет accuracy к vanilla parity или выше — но это
отдельный run (бюджет ~$3-5). Tracked в `current.md` Track K.

Mastra opaque to Langfuse (`@mastra/core` doesn't expose `experimental_telemetry`
option). Diagnostic via `Score.secondary.n_tool_calls` (К-tail instrumentation):
Mastra 346 tools / 25 tasks = 13.8/task; FC analog 358 tools / 25 = 14.3/task.
Comparable tool-call rate.

Effective n=25 (5/30 attachment tasks filtered at bake — xlsx/pdf/pdb/jsonld/docx
not vendored).

Caveats:
- `lme-multiturn` — наше расширение upstream (см. `docs/benchmarks.md §2`);
  budget halt урезал full_context/mastra_om до n=10, anthropic_compact
  не гоняли.
- `mastra_om` actor cost **не bubble** на Phase D строках (assistant-traj,
  longmemeval-med, locomo-med) — `total_$` там = только judge. Backfill
  через `OPENROUTER_PRICING` (input $0.75/M, output $4.50/M). На
  lme-multiturn (commit `5777796`+) actor cost ЕСТЬ — `total_$` полный.
- `anthropic_compact` actor cost тоже не bubble (LITELLM forwarder) —
  backfill тем же способом.
- **AHC на `lme-multiturn` — числа выше отражают post-H Phase 9 ремонт.**
  Pre-fix observer не срабатывал ни разу при `OBSERVER_THRESHOLD=30000`
  (Tier-3 input ≤15.6К токенов, K_RECENT×средний-турн < threshold), что
  давало AHC@30k acc=0.108 vs full_context 0.540. H Phase 9 fix (Tier-2
  cross-turn persistence + adaptive Tier-3 budget, см. `decisions.md
  2026-05-22`) поднял на n=10: AHC@30k acc=0.200, observer fires 10/10
  записей. Headline n=50 rerun отложен (~$60-100; tracked в `current.md`
  Track H). Heterogeneous n: `ahc_full_obs30k` и `mastra-agent` строки
  выше — n=120 (полная baked subset, `--max-tasks-per-cell` опущен в
  первых runs); остальные 3 cells — n=50.
- **Observer extraction lossy на `lme-multiturn`.** Разрыв 30pp post-fix
  (AHC@128k acc=0.200 vs full_context=0.540) — это не truncation, а
  потеря фактов при extraction (observation pipeline отбрасывает точные
  числовые ответы/имена). Confabulation example: task `01493427`
  (ground truth "user added 25 postcards") — full_context отвечает "25" ✓,
  AHC отвечает "17" ✗ (observer вытянул "17" из старшей session). Это
  отдельный workstream (tracked в `current.md` Track H).

## AT corpus version note (Track J — 2026-05-22)

- **AT-v1** (n=30, text-only) — numbers above для `assistant-traj` rows valid
  до 2026-05-22. AT-v1 30 task files retired в Track J3 (`git rm` 9 of 30; 21
  overwritten by AT-v2 drafts на same `at_<cat>_NNN.json` paths). Git history
  preserves AT-v1 content; current `benchmarks/assistant_traj/tasks/` is AT-v2.
- **AT-v2** (n=50, tool-grounded) — current corpus. Per-baseline numbers will
  be regenerated in a J6 follow-up sweep (single seed, smoke budget) и
  лягут в эту же таблицу (Text benches section выше) с пометкой "AT-v2".
  Tracked в `current.md` Track J.
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
injection breaks OpenRouter auto-cache на multi-turn alternation).

**AHC vs vanilla на tau** (Track H follow-up, 2026-05-22): AHC $0.525/episode
vs vanilla $0.601 (−12.6% cheaper), accuracy tied at 0.100. Offloader **не
срабатывает** на real retail tools — их средний размер 470-1894 bytes < нашего
T_SIZE_MIXED=2048 threshold. Type-Aware path doesn't engage без bump'а
threshold (тоже tracked в `current.md` Track H).

**mastra-agent vs uncompacted disclaimer** — Mastra Memory blob inject'ится
в каждый turn (implicit compaction), поэтому `mastra-agent` строки выше **не**
являются pure non-compaction baseline. F-report должен disclose'ить это при
цитировании. Особенно заметно на tau (cache=0%) и lme-multiturn (acc=0.475
при n=40 partial с budget halt $35 → projected $53).

## Cross-bench ablations

Сводка ablation-сигнала по компонентам AHC (источник — H follow-up sweeps,
2026-05-22). Numbers underpowered на n=10 — F-report должен disclose'ить.

**Per-component ablation deltas** (LongMemEval-med, n=10, seed=42):

| variant | Δaccuracy vs AHC-full | toggle |
|---|---|---|
| no_observer | **−0.10** (10pp лоса) | `TASK_AWARE_EXTRACTION=false` |
| no_offloader | **−0.05** | `TYPE_AWARE_OFFLOAD=false` |
| no_classifier | 0 (within noise) | `TRAJECTORY_CLASSIFIER=false` |

Caveat: на синтетических non-AHC cells obs/off/recall events = 0/0/0 — ablation
signal только из AHC-full vs AHC-no-X сравнений; cross-config сравнения
"AHC vs full_context" обсуждаются в Text benches table выше.

**Cache rate cross-bench** (для понимания где AHC tier-3 churn ломает cache):

| bench / provider | cache rate | actor |
|---|---|---|
| longmemeval-med (single-turn) | **97.0%** | OpenRouter + `gpt-5.4-mini` |
| lme-multiturn (replay) | **43%** | OpenRouter + `gpt-5.4-mini` |
| longmemeval-med via LITELLM | 49.1% | LITELLM forwarder + Sonnet |
| longmemeval-med via direct | 22.7% | Google direct + Gemini |
| assistant-traj (AT-v1) | 12.4% | OpenRouter + `gpt-5.4-mini` |

Multi-turn падение 97% → 43% объяснимо: Tier-3 растёт turn-by-turn, кэшится
только system + first user prefix. Цель ≥60% (см. `system_design.md §2.1`)
single-turn — выполняется; multi-turn — нет (open в `current.md` Track H).
AT-v1 cache rate низкий потому что AHC compactit Tier-2 на каждом turn, что
churn'ит prefix — full_context (без compaction) на том же bench получает 34.7%.
