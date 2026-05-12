# References — vendored snapshot

Snapshot upstream agent-generated research (Holosophus AI scientist), на расширении
которого строится текущий MVP. Vendored, не submodule — snapshot semantics, мы не
следим за upstream.

- **Source:** `~/Projects/ai_scientists/Holosophus/workdir/compaction_policies__20260508_0231/`
- **Captured:** 2026-05-13 (timestamp папки источника — 2026-05-08 02:31 UTC)
- **Upstream status:** peer-reviewed paper, Borderline Accept, n=170

## Layout

```
paper/
  paper.pdf      финальный PDF (cite source для F4.1)
  main.tex       LaTeX source — полезен при cite'ах
  refs.bib       bibliography — seed для нашего refs.bib (см. F4)
mle-harness/
  code/          12 runner/judge/aggregator Python files — port source для B1
  results/       NDJSON + summaries + peer_review.md + pareto_data.json — числа для F4.1
```

## Policy

- **Не правим файлы здесь** — это snapshot. Логика harness'а port'ится в `src/eval/`
  под нашу TypeScript архитектуру (фаза B1, см. `docs/design/B_eval-harness.md`).
- Новые версии upstream — обновляем целиком через re-copy в одном коммите, с записью
  в `docs/decisions.md`. Не cherry-pick'аем отдельные файлы.
- `.bak` файлы дропнуты при копировании.

## Где цитируется

- `docs/design/B_eval-harness.md` Meta — B1 port source
- `docs/system_design.md §7.2 B1` — то же
- `docs/design/F_report.md §4.1` — Mem0/Letta/Zep numbers, task-aware/type-aware baselines
