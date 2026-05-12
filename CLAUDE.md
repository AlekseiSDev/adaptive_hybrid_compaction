# Claude Code Instructions — AHC

## Project Context

- **Project:** AHC (Adaptive Hybrid Compaction) — middleware для context compaction
  агентских ассистентских систем на medium-distance траекториях (5–15 turns).
- **Status:** дизайн-фаза, кода ещё нет. Стек разворачивается в Track A (см. system_design §7).
- **Architecture:** layered TypeScript — `core/` (framework-agnostic) → `adapters/` (AI SDK v6
  middleware и baselines) → `eval/` (telemetry, benchmark harness).
- **Key Technologies:** TypeScript, AI SDK v6 (primary integration), Vitest, OpenRouter
  (Gemini-3.1-Flash main actor; GPT-5.4 LLM-judge; Anthropic direct для cache-rate subset).
- **Scope:** учебный MVP курса NLP, ~4 недели wall-clock. Не production-SDK.
- **Primary Verification Command:** `./scripts/verify.sh` (typecheck + lint + unit + cache-invariance).
  Создаётся в Track A1.

## Documentation Routing

Перед нетривиальной работой — читай smallest relevant doc, не грузи всё.

| Документ | Когда читать |
|---|---|
| `docs/index.md` | При сомнении куда смотреть |
| `docs/system_design.md` | Перед любой нетривиальной задачей — цели, scope, phase plan, eval-protocol, принятые решения |
| `docs/ahc-algorithm.md` | Перед работой в `src/core/` — 3-tier shape, classifier, offloader, observer; источник правды для инвариантов (§9 cache invariance, §2.3/§5.1 atomic groups, §5.4/§6.1 pointer roundtrip) |
| `docs/ai-native-practices.md` | При сомнении в процессе или конвенции; описывает pipeline и harness-дисциплину |
| `docs/decisions.md` | Перед предложением альтернативы существующему паттерну |
| `docs/agent-pitfalls.md` | Если файл есть — читай при работе в упомянутых зонах |
| `docs/implementation/<phase>.md` | При работе над конкретной фазой Track A/B/C/D |

## Operating Model: 4-step pipeline

Берём из manifesto-подхода, см. `docs/ai-native-practices.md §2`.

### 0. Research / Spec — уже зафиксированы

- `system_design.md` — что строим, цели, eval-protocol, phase plan.
- `ahc-algorithm.md` — алгоритмическое ядро.

Изменения scope обновляют эти доки **в той же ветке**, что и код, нарушающий старую спеку.

### 1. Implementation plan — перед каждой фазой

Перед стартом фазы (A1, A2, B1, …):

1. Прочитай относящуюся секцию `system_design.md §7.2` и связанный модуль в `ahc-algorithm.md`.
2. Прочитай `decisions.md` — не противоречь принятым решениям.
3. Изучи код в затронутых директориях (ls, grep, прочитай ключевые файлы).
4. Запусти существующие тесты — baseline должен быть зелёным.
5. Создай `docs/implementation/<phase>.md` по `docs/templates/implementation_template.md`:
   scope, step plan, exit criteria, **TDD hook на каждый шаг**, verification.
6. Покажи план человеку. Дождись подтверждения. Не пиши код раньше.

Если корень проблемы или подход неясен — сначала investigation
(`docs/templates/investigation_template.md`), потом план.

### 2. TDD Execution

При изменении логики в `src/core/` или cache-affecting adapter'ах:

```
Red       → failing test, описывающий желаемое поведение или инвариант
Green     → минимальный код, чтобы тест прошёл
Refactor  → чистка без изменения поведения; все тесты остаются зелёными
Verify    → ./scripts/verify.sh; результат — в implementation/<phase>.md
```

**Не пиши код раньше теста.** Если тест не получается сформулировать — требование
не сформулировано; возвращаемся в implementation doc.

При баг-фиксе — сначала failing test, который воспроизводит баг.

TDD **не требуется** для: чистого рефакторинга без смены контракта, документации, конфигов,
telemetry без бизнес-логики.

### 3. Verification

После каждого нетривиального шага — `./scripts/verify.sh`. Результат записывается в
implementation doc (раздел Verification). Если check не запускался — фиксируй gap явно.

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
- **Не правь `system_design.md` или `ahc-algorithm.md` молча.** Если scope или инвариант
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
