# Claude Code Instructions — AHC

## Project Context

- **Project:** AHC (Adaptive Hybrid Compaction) — middleware для context compaction
  агентских ассистентских систем на medium-distance траекториях (5–15 turns).
- **Status:** дизайн-фаза, кода ещё нет. Стек разворачивается в Track A (см. system_design §7).
- **Architecture:** layered TypeScript — `src/core/` (framework-agnostic) → `src/adapters/`
  → `src/eval/` → `src/ui/`. Baselines живут в `src/eval/baselines/` (не `adapters`).
  Полный layout — см. Repository Layout ниже / `system_design §11.6`.
- **Key Technologies:** TypeScript, AI SDK v6 (primary integration), Vitest, OpenRouter
  (Gemini-3.1-Flash main actor; GPT-5.4 LLM-judge; Anthropic direct для cache-rate subset).
- **Scope:** учебный MVP курса NLP, ~4 недели wall-clock. Не production-SDK.
- **Primary Verification Command:** `./scripts/verify.sh` (typecheck + lint + unit + cache-invariance).
  Создаётся в Track A1. Внутри скрипта закладываем pinpoint sub-commands (`typecheck-only`,
  `lint-only`, `test:unit`, `test:cache-invariance`) — полный verify перед коммитом, узкие
  команды для быстрого цикла во время разработки.

## Repository Layout

```
src/{core,adapters,eval,ui}/        # code: A / A6 / B+C / G
eval/sweeps/                        # sweep YAMLs (E)
benchmarks/{assistant_traj,runs}/   # D bench + E output
observability/                      # Langfuse stack (B2, opt-in)
references/                         # vendored upstream snapshot (read-only)
scripts/                            # verify.sh + helpers
docs/                               # design + plans (см. Documentation Routing)
report/                             # final PDF (F)
```

**Track ownership:** `src/core/`→A, `src/adapters/`→A6, `src/eval/` (минус `baselines/`)→B,
`src/eval/baselines/`→C, `src/ui/`→G, `eval/sweeps/`→E, `benchmarks/assistant_traj/`→D,
`benchmarks/runs/`→E (output), `observability/`→B2, `report/`→F.

**Dependency rule:** `core` не импортит из `adapters` / `eval` / `ui` — **никогда**.
`adapters` → `core`. `eval` → `core`. `ui` → `adapters`. Нарушения ловятся вручную; при
первом — поднимаем `eslint-plugin-boundaries` (см. Harness Rules ниже).

**Read-only:** `references/` — vendored snapshot, не правим (см. `references/README.md`).
Канонический layout с подробностями + per-file map — `system_design §11.6`.

## Documentation Routing

Перед нетривиальной работой — читай smallest relevant doc, не грузи всё.

| Документ | Когда читать |
|---|---|
| `docs/index.md` | При сомнении куда смотреть |
| `docs/system_design.md` | Перед любой нетривиальной задачей — цели, scope, phase plan, eval-protocol, принятые решения |
| `docs/design/A_ahc-algorithm.md` | Track A design — перед работой в `src/core/`; 3-tier shape, classifier, offloader, observer, public types (§2.4), инварианты (§9 cache invariance, §2.3/§5.1 atomic groups, §5.4/§6.1 pointer roundtrip) |
| `docs/design/<track>.md` | Track-level design (B eval-harness / C baselines / D assistant-traj / E main-runs / F report) — перед фазой соответствующего трека |
| `docs/decisions.md` | Перед предложением альтернативы существующему паттерну |
| `docs/agent-pitfalls.md` | Если файл есть — читай при работе в упомянутых зонах |
| `docs/templates/track_design_template.md` | Если заводится **новый** трек / долгая инициатива, у которой ещё нет `design/<X>.md` — скаффолд по этому шаблону (гибрид system_design framing + design doc детализации). |

## Operating Model: 4-step pipeline

### 0. Research / Spec — уже зафиксированы

- `system_design.md` — что строим, цели, eval-protocol, phase plan.
- `A_ahc-algorithm.md` — алгоритмическое ядро.

Изменения scope обновляют эти доки **в той же ветке**, что и код, нарушающий старую спеку.

### 1. Перед стартом фазы

Pre-work агента перед стартом фазы (A1, A2, B1, …):

1. Прочитай относящуюся секцию `system_design.md §7.2` и relevant
   `docs/design/<track>.md` (A_ahc-algorithm для A, B_eval-harness для B, …).
2. Прочитай `decisions.md` — не противоречь принятым решениям.
3. Изучи код в затронутых директориях (ls, grep, прочитай ключевые файлы).
4. Запусти существующие тесты — baseline должен быть зелёным.

Дальше план фазы приходит из `/plan-mode` (триггерит пользователь). План содержит:
scope, step plan с TDD seed на каждый шаг, exit criteria, verification — структуру
см. в `Phase map` соответствующего `design/<track>.md`. Агент валидирует план против
шагов 1-2 (spec + decisions) перед началом кодинга. Дождись подтверждения плана.
Не пиши код раньше.

Если инициатива новая и `design/<track>.md` для неё нет — заскаффолди design doc
по `docs/templates/track_design_template.md` одним PR с system_design scope row.

Если корень проблемы или подход неясен — сначала investigation
(`docs/templates/investigation_template.md`), потом план.

### 2. TDD Execution

При изменении логики в `src/core/` или cache-affecting adapter'ах:

```
Red       → failing test, описывающий желаемое поведение или инвариант
Green     → минимальный код, чтобы тест прошёл
Refactor  → чистка без изменения поведения; все тесты остаются зелёными
Verify    → ./scripts/verify.sh; final-phase результат — в commit message
```

**Не пиши код раньше теста.** Если тест не получается сформулировать — требование
не сформулировано; возвращаемся к плану из `/plan-mode`.

При баг-фиксе — сначала failing test, который воспроизводит баг.

TDD **не требуется** для: чистого рефакторинга без смены контракта, документации, конфигов,
telemetry без бизнес-логики.

### 3. Verification

После каждого нетривиального шага — `./scripts/verify.sh`. Финальный результат фазы
фиксируется в commit message (что прогнал, что зелёное). Если check не запускался —
фиксируй gap явно в commit message.

## Code Style

- TypeScript strict mode. Никаких `any` без обоснования в комментарии.
- Маленькие файлы (~300 строк ориентир). Дробим по семантике, не по размеру.
- Явный `index.ts` с re-exports в каждом нетривиальном модуле — наружу видно только public API.
- Имена не сокращаем (`scratchpad`, не `sp`; `atomicGroup`, не `ag`) — токены при чтении
  дешевле, чем загадки.
- Никаких комментариев типа `// helper for X` — название должно говорить само. Комментарий
  оправдан только когда WHY неочевидно (workaround, инвариант, нетривиальное ограничение).
- Зависимости направлены внутрь: `eval → core`, `adapters → core`. `core` не импортит из
  `adapters` или `eval`. **Никогда.**

## Decision Log

Когда принимаем архитектурное или design-решение в ходе реализации, дописываем в
`docs/decisions.md`:

```
- **[YYYY-MM-DD] Title**: Что решили. Почему. [Supersedes: ..., если применимо]
```

Перед добавлением — прочитай файл, не дублируй уже зафиксированное. Существующий список
решений в `system_design.md §8` — historical; новые идут в `decisions.md`.

## Sub-agents

Встроенные сабагенты Claude Code как **context firewall**: parent держит план, child
возвращает только структурированный результат.

- **Поиск/research >3 запросов по репо или `docs/`** — делегируй `Explore`-сабагенту.
  Не засоряй parent context сырым `grep`/`find` (особенно по `system_design.md`,
  `A_ahc-algorithm.md`, `decisions.md` — они длинные).
- **Long-running планирование фазы или нетривиальной задачи** — `Plan`-сабагент или
  `/plan-mode` (триггерит пользователь); результат автосохраняется в `~/.claude/plans/*.md`
  и виден между сессиями.
- Sub-agent получает структурированный prompt с конкретным вопросом и нужными ссылками —
  не parent context целиком.
- Custom multi-agent harness (planner/coder/evaluator поверх AHC) **не строим** — встроенных
  Explore/Plan хватает на MVP scope.

## Harness Rules

Когда одна и та же ошибка случается дважды (или одна дорогая) — добавляем guardrail.
**Patch the system, not the symptom.**

| Тип ошибки | Лечение |
|---|---|
| Нарушение инварианта (cache, atomic, etc.) | Unit test |
| `core` импортит из `adapters` | ESLint rule (`eslint-plugin-boundaries`, добавим при первом нарушении) |
| Агент пропускает план / verify | Уточнение в этом файле |
| Незнание helper'а или соглашения | Запись в `docs/agent-pitfalls.md` + ссылка отсюда |
| Повторяющийся стилевой мисс | Reference-файл как эталон в этом файле |

Не пишем guardrails превентивно. `agent-pitfalls.md` пуст до первой повторной ошибки.

## Workflow Anti-Patterns

- **Не дублируй существующий helper / соглашение.** Перед созданием нового модуля или
  helper'а — grep по существующему коду, результаты приложи в plan.
- **Не пиши код раньше теста на core-логике.** См. TDD discipline выше.
- **Не правь `system_design.md` или `A_ahc-algorithm.md` молча.** Если scope или инвариант
  меняется — отдельный коммит с обоснованием, обновляем доку одновременно с кодом.
- **Не добавляй фичи "на всякий случай".** MVP scope короткий; всё, что не в
  `system_design.md §7`, требует обоснования.
- **Не вводи абстракции до второго use-case.** Three similar lines > premature abstraction.

## Git Discipline

- Один PR — одно изменение. Feature + рефакторинг + чистка имён — три разных коммита.
- Перед коммитом — `./scripts/verify.sh` зелёный.
- Не push'им до явного подтверждения пользователем.
- Не используем `--no-verify` / `--force` без явной просьбы.
- В сообщении коммита — что и зачем; не "fix" / "update".

## Notes on Style

Этот файл — **operative**, не справочник. Если запись здесь не меняет поведение в типичной
сессии — она лишняя. При повторной ошибке — добавляем; при отмирании правила — убираем.
