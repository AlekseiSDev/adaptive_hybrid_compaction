# Docs Index

Routing-карта проекта AHC. Используй её, чтобы найти **smallest authoritative document**
для текущего вопроса — не грузи всё подряд.

## Canonical docs

| Файл | Роль |
|---|---|
| [`../README.md`](../README.md) | Public framing — что за проект и зачем |
| [`../CLAUDE.md`](../CLAUDE.md) | Operative instructions для Claude Code: routing, pipeline, TDD, harness rules |
| [`system_design.md`](system_design.md) | Цели, scope, архитектура, eval-protocol, phase plan, принятые решения |
| [`ahc-algorithm.md`](ahc-algorithm.md) | Алгоритмическое ядро (Track A design): 3-tier shape, classifier, offloader, observer, инварианты, public types |
| [`ai-native-practices.md`](ai-native-practices.md) | Дисциплина работы с агентом: pipeline, harness, что взяли / отложили |
| [`decisions.md`](decisions.md) | Append-only лог архитектурных и design-решений |
| [`agent-pitfalls.md`](agent-pitfalls.md) | Anti-pattern log (создаётся при первой повторной ошибке) |

## Track-level design docs

Промежуточный слой между `system_design.md` (intent + phases) и `implementation/<phase>.md`
(per-step plan). Один трек — один документ; не дробим под фазы. Каждый трек имеет
свой design doc для единообразного routing.

| Файл | Трек | Когда читать |
|---|---|---|
| [`ahc-algorithm.md`](ahc-algorithm.md) | A (core) | Перед любой фазой A1–A6 — 3-tier shape, classifier, offloader, observer, инварианты, public types |
| [`design/eval-harness.md`](design/eval-harness.md) | B (eval) | Перед B1–B3 — telemetry schema, run persistence, statistical pipeline, cost circuit-breaker |
| [`design/baselines.md`](design/baselines.md) | C (baselines) | Перед C1–C3 — common Baseline interface, Mastra OM / Anthropic native / full-context wrappers |
| [`design/assistant-traj.md`](design/assistant-traj.md) | D (AssistantTraj) | Перед D1–D4 — task JSON schema, source pipeline, anonymization, judge rubric |
| [`design/main-runs.md`](design/main-runs.md) | E (sweeps) | Перед E1–E3 — orchestration, parallelization, replication, failure recovery |
| [`design/report.md`](design/report.md) | F (report) | Перед F1–F3 — section outline, figure plan, citation plan, reproducibility appendix |

Track A design исторически лежит в `ahc-algorithm.md` на корне `docs/` (не в `design/`)
для backward-link consistency. Остальные — в `docs/design/`.

## Per-phase tracking

Создаются перед стартом каждой фазы (A1, A2, B1, …) из `system_design §7.2`. Шаблон —
[`templates/implementation_template.md`](templates/implementation_template.md).

- `implementation/<phase>.md` — scope, step plan, exit criteria, TDD hooks, verification.

## Investigations (по необходимости)

Когда root-cause или подход неясны — заводим `investigations/<topic>.md` по
[`templates/investigation_template.md`](templates/investigation_template.md).

## Templates

- [`templates/implementation_template.md`](templates/implementation_template.md) — per-phase plan
- [`templates/investigation_template.md`](templates/investigation_template.md) — root-cause analysis

## Reading paths

- **Старт работы над любой фазой:** `system_design §7.2` → relevant track design
  (`ahc-algorithm.md` для A; `design/<track>.md` для B/C/D/E/F) → `decisions.md` →
  `implementation/<phase>.md` (создать по шаблону).
- **Bug или непонятное поведение:** `investigations/<topic>.md` (создать) → решение →
  если закрыто guardrail'ом, обновить CLAUDE.md / agent-pitfalls.md.
- **Изменение архитектуры или scope:** обновить `system_design.md`, `ahc-algorithm.md`
  или relevant `design/<track>.md` в той же ветке, что и код; добавить запись в `decisions.md`.
- **Сомнения в процессе:** `ai-native-practices.md`.

Принцип: не загружай больше документа, чем нужно. Расширяй по мере блокировки.
