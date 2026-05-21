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

Caveats:
- `lme-multiturn` — наше расширение upstream (см. `docs/benchmarks.md §2`);
  budget halt урезал FC/mastra до n=10, anthropic_compact не гоняли.
- `mastra_om` actor cost **не bubble** на Phase D строках (assistant-traj,
  longmemeval-med, locomo-med) — `total_$` там = только judge. Backfill
  через `OPENROUTER_PRICING` (input $0.75/M, output $4.50/M). На
  lme-multiturn (commit `5777796`+) actor cost ЕСТЬ — `total_$` полный.
- `anthropic_compact` actor cost тоже не bubble (LITELLM forwarder) —
  backfill тем же способом.

## Tau-bench retail

| baseline | n (pooled seeds) | acc | cost_$/episode |
|---|---|---|---|
| tau_bench_agent (vanilla) | 60 | 0.100 | 0.601 |

(seeds=42,43, n=30 на seed.)
