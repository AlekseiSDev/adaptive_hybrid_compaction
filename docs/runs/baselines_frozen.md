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

### gaia-med (Track K + K-tail, 2026-05-26, после Mastra maxSteps fix)

`main_e1_gaia_competitors.yaml` × n=25 × seed=42 × `gpt-5.4-mini` (OpenRouter),
SearXNG via `observability/searxng-docker-compose.yml`. Source:
`docs/runs/k_gaia_audit.md`.

| bench | baseline | n | input_tok | acc | cost_$ | $/task |
|---|---|---|---|---|---|---|
| gaia-med | gaia_bench_agent | 25 | 1 715 589 | **0.320** | 1.347 | 0.054 |
| gaia-med | mastra-agent ✠ | 25 | 953 688 | **0.280** | 0.829 | 0.033 |
| gaia-med | gaia_bench_agent_ahc | — | — | — | — | — (deferred, отдельный run) |

✠ Track K-tail (2026-05-26): Mastra Agent + Memory + LibSQL + GAIA tools.
Initial run gave acc=0.160 ($0.525) из-за `maxSteps=20` cap без final-text
fallback — 9/25 tasks завершались с empty response. Fix: bumped
`DEFAULT_MAX_STEPS` в `src/eval/adapters/gaia-med/mastra-agent-runner.ts`
к 40; rerun acc=0.280 ($0.829), 4/25 empty (down from 9/25).

Per-level (1/2/3): vanilla 4/7 + 4/14 + 0/4; mastra 4/7 + 3/14 + 0/4.
Mastra recovered к vanilla parity на level-1; both fail level-3
(gpt-5.4-mini capability ceiling).

Mastra opaque to Langfuse (Mastra не emit AI SDK auto-spans for internal
ReACT). Diagnostic via `Score.secondary.n_tool_calls` (К-tail
instrumentation): Mastra 521 tool calls vs vanilla 358 (1.5× more
per task). Mastra Memory compacts 56% fewer input tokens (953K vs 1.7M)
с −0.04 acc penalty — cost-effective compaction trade-off.

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
