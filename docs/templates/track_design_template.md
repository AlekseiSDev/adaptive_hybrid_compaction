# [Initiative Name] — Design

Документ описывает [одно-двух-словное framing: алгоритмическое ядро / track / долгая
инициатива]: модули, контракты, pseudocode, инварианты. Source of truth для имплементации.

Системные цели, scope, eval-protocol и phase plan — см. `system_design.md`.

> **Prereq.** В `system_design.md §7` (phase plan) уже есть scope-row для этой инициативы
> с фазами и milestone'ом. Если нет — добавь её одним PR с этим документом, иначе
> design-doc будет висеть в воздухе.

---

## Meta

- **Initiative:** [name + phase letters, e.g. "Track X (X1 ... → X2 ... → X3 ...)"]
- **Wall-clock:** [days, сумма по фазам]
- **Бюджет:** [$ / API calls — если применимо; иначе строку выкинуть]
- **Зависит от:** [внутри-проекта prereqs; external investigations / vendored snapshots]
- **Блокирует:** [downstream consumers — другие треки / инициативы / sweeps]
- **Артефакт:** [если deliverable нестандартный — PDF, dataset, ноутбук; иначе строку выкинуть]
- **Owner:** [если разные люди отвечают за разные куски; иначе выкинуть]
- **Связь:** [`system_design §X`, `design/<related>.md §Y`, `decisions.md`]

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (пользователю / на защите). Per-phase — exit signal для
> агента-реализатора, симметричный TDD seed на входе.

### [Initiative] (после финальной фазы)

**Доступно:**
- [User-visible API / CLI / file артефакт; конкретные пути.]

**Demo (e2e):** `<реальная команда, 1-2 строки>` — что делает, что печатает.
Если deliverable — UI / PDF / dataset, demo = "открыть X" + одна build-команда.

**Acceptance gate:** `./scripts/verify.sh` зелёный + [специфичный для трека check:
demo не падает / NDJSON содержит required поля / post-run audit пройден / etc.].

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **X1** | [что появляется в коде / на диске / в UI] | [`./scripts/verify.sh <subcmd>` или конкретный `pnpm exec vitest run <path>` или manual gate] |
| **X2** | ... | ... |

Verify-команды адаптируй под природу трека: код → `vitest`/`verify.sh`; execution → pre-flight
+ post-run audit; writing → build + manual review; UI → manual smoke.

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track [X]`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы / интерфейсы / артефакты, которые трогает или вводит фаза.
- **TDD seed** — failing test / gating check, с которого фаза стартует (Red в TDD-цикле; для execution-треков — pre-flight gate).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **X1** [shape / first deliverable] | — | X2, X3 | §A, §B | `Type1`, `Type2` | [failing test / pre-flight gate] | [§C, §D — для правок на стыке] |
| **X2** ... | X1 | X3 | ... | ... | ... | ... |

**Parallelization:** [какие фазы параллельны после Xi; что ждёт всех; в каком порядке кросс-трек разблокировки].

**Orthogonal / deferred:**
- §[...] — [почему orthogonal — calibration / optional polish / etc.].

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Терминология

[Уникальные термины этой инициативы. Если переиспользуются термины из `system_design §1`
или `design/<other>.md §1` — ссылайся, не дублируй.]

- **[Term 1]** — [определение].
- ...

---

## 2. Архитектура

### 2.1 [Shape / data structure]

[Описать ключевую data structure / state shape / external schema. Диаграмму — если
помогает понять.]

### 2.2 [Data flow]

[Pipeline / последовательность операций per turn / per call / per run. Кто вызывает кого,
кто кому передаёт state.]

### 2.3 [Modules]

| Module | Role | File | Track-phase |
|---|---|---|---|
| ... | ... | `src/.../...` | X1 / X2 / ... |

### 2.4 [Public types / contracts]

```typescript
// Минимальный набор типов, образующих публичную surface. Любая правка тут — отдельный
// PR + запись в decisions.md.
type Foo = { ... }
```

---

## 3. [Core module 1]

### 3.1 Contract
### 3.2 Pseudocode
### 3.3 Failure modes / fallbacks

---

## [N]. Инварианты

Hard contracts, которые любое изменение должно сохранять. Каждый инвариант — testable
(или явный manual gate).

### N.1 [Invariant name]

[Формулировка + как проверяется (unit test / integration / runtime assert / manual)].

---

## [N+1]. Open questions

- **[Q]** — [почему открыт; где revisit'нем; deadline]
