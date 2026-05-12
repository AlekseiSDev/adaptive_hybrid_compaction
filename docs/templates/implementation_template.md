# Implementation Tracking: [Phase Name, e.g. A2 — Type-Aware Offloader]

## Meta

- **Date Created:** [YYYY-MM-DD]
- **Date Updated:** [YYYY-MM-DD]
- **Status:** Draft | In Progress | Completed
- **Phase:** [A1 / A2 / B1 / ... из system_design §7.2]
- **Related:** [system_design §..., ahc-algorithm §..., investigation doc если был]

## Core Transformation

Коротко: что меняется в системе и какой инвариант или поведение получаем в итоге.

## Scope

- **In scope:** что реально делаем в этой фазе.
- **Out of scope:** что сознательно откладываем.

## Plan

### Step 1: [Step Name]

- **Change:** что меняем (файлы, функции, контракты).
- **Exit Criteria:** как поймём, что шаг завершён (наблюдаемое поведение или тест).
- **TDD Hook:** какой failing test появляется первым (имя файла + что проверяет).
- **Harness Update:** какой rule / agent-pitfalls запись / lint нужен, если шаг
  меняет инвариант или вводит соглашение. (Часто — нет.)

### Step 2: [Step Name]

- **Change:**
- **Exit Criteria:**
- **TDD Hook:**
- **Harness Update:**

## Progress

| Step | Status | Notes |
|---|---|---|
| Step 1 | pending | |
| Step 2 | pending | |

## Verification

| Check | Type | Result | Notes |
|---|---|---|---|
| `./scripts/verify.sh` | unit + invariance + lint + tsc | pending | |
| Targeted test: [path] | unit | pending | |
| [integration / e2e если применимо] | | | |

## Deviations

- Чем фактическая реализация отклонилась от plan и почему.

## Risks / Follow-ups

- Что осталось за рамками этой фазы.
- Какие decisions нужно вынести в `decisions.md`.
- Какие harness-обновления (правила в CLAUDE.md, agent-pitfalls) стоит сделать после мержа.
