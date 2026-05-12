# Docs Index

Routing-карта проекта AHC. Используй её, чтобы найти **smallest authoritative document**
для текущего вопроса — не грузи всё подряд.

## Canonical docs

| Файл | Роль |
|---|---|
| [`../README.md`](../README.md) | Public framing — что за проект и зачем |
| [`../CLAUDE.md`](../CLAUDE.md) | Operative instructions для Claude Code: routing, pipeline, TDD, harness rules |
| [`system_design.md`](system_design.md) | Цели, scope, архитектура, eval-protocol, phase plan, принятые решения |
| [`ahc-algorithm.md`](ahc-algorithm.md) | Алгоритмическое ядро: 3-tier shape, classifier, offloader, observer, инварианты |
| [`ai-native-practices.md`](ai-native-practices.md) | Дисциплина работы с агентом: pipeline, harness, что взяли / отложили |
| [`decisions.md`](decisions.md) | Append-only лог архитектурных и design-решений |
| [`agent-pitfalls.md`](agent-pitfalls.md) | Anti-pattern log (создаётся при первой повторной ошибке) |

## Per-phase tracking

Создаются перед стартом фазы Track A/B/C/D из `system_design §7.2`. Шаблон —
[`templates/implementation_template.md`](templates/implementation_template.md).

- `implementation/<phase>.md` — scope, step plan, exit criteria, TDD hooks, verification.

## Investigations (по необходимости)

Когда root-cause или подход неясны — заводим `investigations/<topic>.md` по
[`templates/investigation_template.md`](templates/investigation_template.md).

## Templates

- [`templates/implementation_template.md`](templates/implementation_template.md) — per-phase plan
- [`templates/investigation_template.md`](templates/investigation_template.md) — root-cause analysis

## Reading paths

- **Старт работы над фазой:** `system_design §7` → relevant `ahc-algorithm` секция →
  `decisions.md` → `implementation/<phase>.md` (создать).
- **Bug или непонятное поведение:** `investigations/<topic>.md` (создать) → решение → если
  закрыто guardrail'ом, обновить CLAUDE.md / agent-pitfalls.md.
- **Изменение архитектуры или scope:** обновить `system_design.md` или `ahc-algorithm.md`
  в той же ветке, что и код; добавить запись в `decisions.md`.
- **Сомнения в процессе:** `ai-native-practices.md`.

Принцип: не загружай больше документа, чем нужно. Расширяй по мере блокировки.
