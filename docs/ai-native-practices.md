# AI-Native Practices — AHC

> Документ описывает, как мы организуем репозиторий и harness для работы Claude Code на
> проекте AHC. Это **учебный MVP с коротким горизонтом (~4 недели)** — берём только то,
> что окупается на этом масштабе. Полный обзор практик и таксономия — см. источники в
> конце; здесь — solo-friendly адаптация.

---

## 1. Базовые понятия

**AI-native repo** — репозиторий, структурированный так, чтобы кодинг-агент работал
предсказуемо: явные интерфейсы, маленькие файлы, документация рядом с кодом, проверяемые
механически инварианты.

**Harness engineering** — runtime агента: CLAUDE.md, skills, hooks, sub-agents, контекстные
политики. Формула комьюнити: `Agent = Model + Harness`. Когда агент повторяет ошибку —
не патчим симптом, патчим систему (правило в CLAUDE.md, тест, lint-rule, переименование).

**Принцип единственного источника правды:** если знание не в репо — для агента его не
существует. Чаты, голова, Google Docs — невидимы.

---

## 2. Operating Model: 4-шаговый pipeline

Берём из [agent-engineering-manifesto](https://github.com/AlekseiSDev/agent-engineering-manifesto)
адаптированный под research-проект pipeline:

```
0. Research/Spec       → docs/system_design.md (что строим, цели, eval-protocol)
                       → docs/design/A_ahc-algorithm.md (алгоритмическое ядро, инварианты)
   ─ уже зафиксированы; обновляются при изменении scope ─

1. Implementation plan → docs/implementation/<phase>.md
   ─ создаётся перед началом каждой фазы (A1, A2, …); step-by-step c exit criteria и TDD hooks

2. TDD execution       → Red → Green → Refactor → Verify against step contract
   ─ обязательно для всего, что меняет логику compaction; см. §6

3. Verification        → ./scripts/verify.sh (typecheck + lint + unit + cache invariance)
                       → запись результатов в implementation doc
```

**Investigation как entry path** — когда проблема или root-cause неясны (например, classifier
даёт неожиданный класс на калибровочной трассе): сначала собираем evidence, формируем
гипотезы, проверяем. Только потом план. Шаблон — `docs/templates/investigation_template.md`.

**Harness как cross-cutting practice** — каждый раз, когда агент совершил ту же ошибку
дважды (или одну дорогую), добавляем guardrail: правило в CLAUDE.md, unit test, lint rule,
или anti-pattern запись. Подробнее — §7.

---

## 3. Структура репозитория

Layered TypeScript с явными границами. AI SDK v6 как primary integration, но core
framework-agnostic.

```
adaptive_hybrid_compaction/
├── CLAUDE.md                      # operative instruction set
├── README.md                      # public framing
├── package.json
├── tsconfig.json
├── eslint.config.js               # source of truth для стиля
├── docs/
│   ├── index.md                   # routing внутрь docs
│   ├── system_design.md           # цели, scope, eval-protocol
│   ├── ai-native-practices.md     # этот файл
│   ├── decisions.md               # append-only лог решений
│   ├── agent-pitfalls.md          # anti-pattern log (создаётся по мере)
│   ├── design/                    # track-level design docs (A — core, B — eval, …)
│   │   ├── A_ahc-algorithm.md     # алгоритмическое ядро (Track A)
│   │   ├── B_eval-harness.md
│   │   ├── C_baselines.md
│   │   ├── D_assistant-traj.md
│   │   ├── E_main-runs.md
│   │   └── F_report.md
│   ├── implementation/            # per-phase tracking docs
│   │   └── <phase>.md
│   ├── investigations/            # по необходимости
│   │   └── <topic>.md
│   └── templates/                 # шаблоны
├── src/
│   ├── core/                      # pure compaction logic, framework-agnostic
│   │   ├── index.ts               # явный public API
│   │   ├── tiers.ts               # 3-tier data structures
│   │   ├── tiers.test.ts          # co-located unit test
│   │   ├── classifier.ts
│   │   ├── offloader.ts
│   │   ├── observer.ts
│   │   └── ...
│   ├── adapters/                  # AI SDK v6 middleware, Anthropic native baseline
│   │   ├── index.ts
│   │   └── ai-sdk-v6.ts
│   └── eval/                      # harness extensions, telemetry, benchmark adapters
│       ├── index.ts
│       └── ...
├── tests/                         # integration + cache invariance contract
│   ├── cache-invariance.test.ts
│   └── e2e/
├── scripts/
│   └── verify.sh                  # одна команда — все checks
└── benchmarks/                    # task definitions, traces, fixtures
```

Ключевые свойства:

- Зависимости направлены внутрь: `adapters → core`, `eval → core`. `core` не импортит из
  `adapters` или `eval`.
- В каждом нетривиальном модуле — `index.ts` с явным public API (re-exports).
- Unit-тесты co-located с кодом; integration и cache-invariance — в `tests/`.
- Маленькие файлы — до ~300 строк ориентир, разделяем когда раздувается.
- `scripts/verify.sh` — единая точка входа для всего, что должен запускать агент.

---

## 4. Documentation Routing

Один файл `docs/index.md` — карта репо. CLAUDE.md ссылается на него в первой секции, агент
при старте сессии получает routing в ~30 строк вместо grep-сканирования.

| Файл | Когда читать |
|---|---|
| `docs/system_design.md` | Перед любой нетривиальной работой — что строим, цели, eval-protocol |
| `docs/design/A_ahc-algorithm.md` | Перед работой с core: 3-tier shape, classifier, offloader, observer, инварианты |
| `docs/decisions.md` | Перед предложением альтернативы существующему паттерну |
| `docs/implementation/<phase>.md` | При работе над конкретной фазой |
| `docs/agent-pitfalls.md` | При работе в зонах, где уже спотыкались |
| `docs/ai-native-practices.md` | При сомнении в процессе/конвенции |

Принцип: не грузим всё по умолчанию. Берём smallest relevant doc, расширяем когда заблокированы.

---

## 5. Минимальный набор практик для AHC

Берём из tier-таксономии только то, что окупается на 4-недельном solo-проекте. Остальное
— в §8 как potential future.

### 5.1 Foundation (T0)

- **CLAUDE.md в корне** — operative instructions: project context, routing, planning workflow,
  TDD discipline, harness rules, code style, anti-patterns. См. сам файл — это и есть
  имплементация.
- **`scripts/verify.sh`** — одна команда: `tsc --noEmit && eslint . && vitest run`. Агент
  использует её после каждого нетривиального изменения. Cache-invariance test — часть unit
  suite, не отдельная команда.
- **Sandbox** — defaults Claude Code достаточно. Опасные операции (force push, удаление
  большого числа файлов) — через явное подтверждение пользователя.
- **Предсказуемая структура** — §3. Новый код попадает в `core/` или `adapters/` по
  семантике; eval-only — в `eval/`.

### 5.2 Repository hygiene (T1)

- **Co-located README в core/** — короткий контекст модуля: что делает, какие инварианты
  держит, как тестируется. Не дублируем сигнатуры — только зачем и контракт.
- **`docs/decisions.md`** — append-only лог архитектурных и design-решений.
  В `system_design.md §8` уже есть список принятых решений — продолжаем туда, либо
  выносим в `decisions.md` когда станет больше 15 записей.
- **Anti-pattern log (`docs/agent-pitfalls.md`)** — создаём при первой повторной ошибке.
  Принцип Хашимото: вторая та же ошибка → запись. Не пишем превентивно.
- **Явные `index.ts`** — внутри модуля видно всё, снаружи только то, что в re-exports.
- **`docs/index.md`** — routing-карта (§4).
- **Spec-first для каждой фазы (Track A)** — перед стартом A1, A2, … создаём
  `docs/implementation/<phase>.md` по [шаблону](templates/implementation_template.md):
  scope, step plan, exit criteria, TDD hooks, verification. Это **главная защита** от
  размывания scope и невалидного ревью.

### 5.3 Что отложили на потом

См. §8.

---

## 6. TDD discipline (главная практика проекта)

AHC — компонент с **жёсткими инвариантами** (cache invariance, atomic group integrity,
classifier monotonicity). Логика без тестов — недопустима. Берём из манифеста:

### 6.1 Когда обязательно TDD

- Меняется любая логика в `src/core/` (3-tier shape, classifier, offloader, observer,
  scratchpad).
- Меняется adapter, влияющий на assembled context (cache-affecting).
- Чинится баг — сначала пишем failing test, который его воспроизводит.

### 6.2 Цикл

```
1. Red       — failing test, который описывает желаемое поведение или инвариант
2. Green     — минимальный код, чтобы тест прошёл
3. Refactor  — чистим без изменения поведения; все тесты остаются зелёными
4. Verify    — ./scripts/verify.sh; результат в implementation/<phase>.md
```

Не пишем код раньше теста. Если тест не получается сформулировать — это сигнал, что
требование не сформулировано; возвращаемся в implementation doc.

### 6.3 Инвариантные тесты (хардкорные harness'ы)

Эти тесты — главные guardrail'ы; их падение блокирует мерж независимо от unit-coverage.

| Тест | Что проверяет |
|---|---|
| `cache-invariance.test.ts` | `prefix(compact(history_i)) == prefix(compact(history_{i-1}))` между reflection-событиями |
| `atomic-group.test.ts` | tool_use всегда парен tool_result; pointer-replacement атомарен |
| `classifier-features.test.ts` | features на ground-truth трассах с known classes |
| `offload-roundtrip.test.ts` | recall возвращает байты, идентичные исходному tool_result |

Эти контракты явно прописаны в `A_ahc-algorithm.md §9`, `§2.3`, `§3.1`, `§5.4` — должны
быть переведены в код один-к-одному.

### 6.4 Когда TDD не нужен

- Чистый рефакторинг без изменения публичного контракта — pre-existing тесты должны
  оставаться зелёными, новые писать не обязательно.
- Документация, скрипты, конфиги.
- Telemetry/logging без бизнес-логики.

---

## 7. Harness engineering на проекте

Принцип: **patch the system, not the symptom**. Каждый guardrail должен снижать
вероятность повторной ошибки в будущих сессиях.

### 7.1 Когда добавляем guardrail

- Та же ошибка дважды (Хашимото-rule).
- Одна дорогая ошибка (например, cache invariance broken → проиграли часы на debug eval'ов).
- Класс ошибки, которую агент не может поймать сам без подсказки (не очевидно из кода).

### 7.2 Какой формат выбрать

| Тип ошибки | Лечение |
|---|---|
| Логическое нарушение инварианта | Unit test (преимущественно) |
| Архитектурная граница (`core` импортит из `adapters`) | ESLint rule с `eslint-plugin-boundaries` (вводим только при первом нарушении) |
| Workflow-confusion (агент пропускает план / verify) | Правило в CLAUDE.md |
| Незнание существующего helper'а / соглашения | Запись в `docs/agent-pitfalls.md` + ссылка из CLAUDE.md |
| Повторяющийся стилистический мисс | Reference-файл как эталон в CLAUDE.md |

### 7.3 Что не делаем превентивно

- Не пишем `agent-pitfalls.md` "на всякий случай" — он начинается пустым, наполняется
  по факту повторных ошибок.
- Не добавляем mechanical rules (dependency-cruiser, boundaries plugin) до первого
  нарушения — overhead на solo-проекте не окупается.
- Не пишем skills под каждый модуль — на MVP CLAUDE.md + co-located README достаточно.

---

## 8. Potential future (не в MVP)

Намеренно за бортом — берём, только если появится конкретная боль или будем готовить
к проду / paper.

- **Иерархические AGENTS.md per-module** — пока репо ≤ ~30 файлов кода, лишний слой.
- **Skills с progressive disclosure** — окупаются на больших командах и многих интеграциях;
  для нашего scope CLAUDE.md ёмкий.
- **Sub-agents как context firewall** — встроенные в Claude Code (`Explore`, `general-purpose`)
  используем по необходимости; кастомных не пишем.
- **Generator-Evaluator / pre-review агенты** — рассмотрим, если объём кода вырастет до
  >2K LOC и человеческое ревью перестанет масштабироваться.
- **Mechanical architecture rules (dependency-cruiser)** — добавим по первому нарушению.
- **Telemetry & evals на critical paths** — у нас уже есть eval-harness для бенчмарков
  (Track B); полноценные harness-evals (типа SWE-bench под себя) — overkill.
- **Garbage-collection агенты на расписании** — не нужно на 4 недели.
- **Semantic codebase index** — `docs/index.md` покрывает.
- **Ralph Loop, A2A, auto-skills** — экспериментальные, не валидированы, пропускаем.

---

## 9. Связь с курсовым проектом и потенциальным paper

- **На время курса**: эти практики — личная дисциплина, не часть отчёта. В отчёте может
  быть упомянуто как "reproducibility appendix" с ссылкой на репо.
- **Если пробьём метрики и пойдёт в paper / прод**: пересмотрим §8 — особенно skills,
  per-module AGENTS.md, dependency-cruiser, observability.

---

## Источники

- [agent-engineering-manifesto](https://github.com/AlekseiSDev/agent-engineering-manifesto) —
  основа pipeline и TDD-дисциплины (4-step model, investigation/harness разделение, templates).
- [OpenAI — Harness engineering](https://openai.com/index/harness-engineering/) — концепция
  репо как единственного контекста агента, mechanical rules.
- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  — hooks, planner/coder/evaluator паттерны.
- [GitHub Copilot — Agent-driven development](https://github.blog/ai-and-ml/github-copilot/agent-driven-development-in-copilot-applied-science/)
  — приоритизация рефакторингов/тестов как критический путь.
- [Mitchell Hashimoto — My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
  — anti-pattern log как корпоративная память.
