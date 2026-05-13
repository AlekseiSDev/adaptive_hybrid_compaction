# AHC — Adaptive Hybrid Compaction

Middleware для компакции контекста агентских ассистентских систем на medium-distance
траекториях (5–15 turns, ~20–80 atomic steps). Навешивается на AI SDK v6 через
`wrapLanguageModel({middleware})` без изменений пользовательского кода.

---

## О чём работа

Мы предлагаем **AHC (Adaptive Hybrid Compaction)** — алгоритм сжатия истории сессии
для агента с tool-use, который вобрал в себя приёмы из работ и фреймворков
последнего года и собирает из них рабочую среднюю.

Что AHC делает за один проход компакции:

1. **Классифицирует траекторию** — `conversational | tool_heavy | mixed` —
   на дешёвых rules-based признаках, без LLM-вызова.
2. **Маршрутизирует политику** под класс: на conversational преобладает
   query-anchored extraction (task-aware Observer), на tool_heavy —
   offload heavy `tool_result` в scratchpad с pointer-placeholder
   (type-aware Offloader), на mixed обе работают одновременно.
3. **Сохраняет cache-invariant prefix** в 3-tier shape: Tier-1 (immutable
   system + tools), Tier-2 (append-only observations + pointers), Tier-3
   (mutable recent turns). Cache breakpoint — в конце Tier-1, инвариант
   проверяется отдельным unit-suite.
4. **Возвращает агенту способ догрузить отложенное** — `recall_tool_result(id)`
   tool инжектируется автоматически когда есть offloaded items.

Из чего собиралась средняя:

- **3-tier append-only shape** — Mastra Operative Memory как ближайший
  концептуальный референс ([refs.bib `mastra_om_2026`](report/refs.bib)).
- **Pointer + scratchpad + recall** — линия MemGPT/Letta как
  «OS-like memory management» ([`memgpt_2023`](report/refs.bib)).
- **Trajectory class signal как routing-фича** — отклик на эмпирические
  наблюдения, что single-policy compaction проигрывает на смешанных
  траекториях; ср. `complexity_trap_2025`, `agent_omit_2026`.
- **Adaptive compaction как native middleware** — функционально соседствует
  с Anthropic `compact_20260112` (`anthropic_compact_2026`) и
  LLMLingua-семейством (`llmlingua_2023`), но архитектурно живёт на уровне
  language model middleware AI SDK v6, не на уровне prompt-обработчика.
- **Eval-протокол** — компакция тестируется как recall-stress + agentic-state stress
  на LongMemEval (`longmemeval_2024`), LoCoMo (`locomo_2024`), τ-bench (`taubench_2024`)
  плюс наш кастомный AssistantTraj (multimodal ассистентские трассы).

Полная библиография — [`report/refs.bib`](report/refs.bib),
финальный отчёт по работе — [`report/main.md`](report/main.md).

---

## Как работает алгоритм кратко

Paper-style overview алгоритма (что внутри, зачем, чем вдохновлено, почему так а
не иначе) — **[`docs/ahc-algorithm.md`](docs/ahc-algorithm.md)**.
Детальная спецификация с pseudocode и инвариантами — [`docs/design/A_ahc-algorithm.md`](docs/design/A_ahc-algorithm.md)
(§2.3 модули, §2.4 public API, §5 atomic-groups, §9 cache invariance).

```
                       ┌────────────────────┐
   incoming messages → │ Trajectory         │ ─ features (tool_call_density,
                       │ Classifier         │   avg_tool_result_size,
                       │ (rules, no-LLM)    │   user_turn_ratio, …)
                       └────────┬───────────┘
                                │ class ∈ {conv, tool_heavy, mixed}
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
   ┌──────────────────────┐         ┌──────────────────────────┐
   │ Task-aware Observer  │         │ Type-aware Offloader     │
   │ • query-anchored     │         │ • atomic-group detection │
   │   extraction Tier-3  │         │   (tool_use/result пара) │
   │   → observations     │         │ • > threshold → scratch- │
   │   в Tier-2           │         │   pad, замена pointer'ом │
   │ • async-буфер        │         │ • инъекция recall_tool_  │
   │   (Mastra-style)     │         │   result(id) tool        │
   └──────────────────────┘         └──────────────────────────┘
                │                                   │
                └──────────────────┬────────────────┘
                                   ▼
                       ┌────────────────────┐
                       │ assembleContext()  │
                       │ Tier-1 + Tier-2 +  │ ← cache breakpoint
                       │ Tier-3             │   в конце Tier-1
                       └────────┬───────────┘
                                ▼
                    streamText / generateText
```

- **Tier-1** — immutable prefix (system + tools + first user msg). Cache hit by construction.
- **Tier-2** — append-only observations + pointer-placeholders + class signal.
- **Tier-3** — mutable hot context (последние K turns).
- **Reflection** — единственная операция, которая перепаковывает Tier-2 (deep recompression);
  событие observable + редкое, под feature-flag.

---

## Статус результатов

MVP курсового проекта, не production paper. По шкале «что замерено достоверно»:

| Контур | Что замерено | Статус |
|---|---|---|
| **AssistantTraj** (custom bench, 30 tasks × 2 seeds = n=60/cell) | AHC vs full_context: accuracy 0.292 vs 0.225 (Δ = +0.067, ≈1 SE), стоимость на задачу −16% | Направленный сигнал на главном бенче |
| **LME-med / LoCoMo-med / τ-bench-retail-med** | Pipeline integration, n ≤ 3 per cell (smoke) | Заведены и проходят end-to-end, не powered measurement |
| **Cache-hit** (Anthropic direct) | Под минимальным input-size для prompt-cache | Отдельный scope-redux, отмечен в отчёте |

Подробнее — [`report/main.md`](report/main.md) Abstract + §6 Results; полная история
scope-редукций и trade-off'ов — [`docs/decisions.md`](docs/decisions.md).

---

## Где смотреть теорию и код

### Теория

| Документ | О чём |
|---|---|
| [`report/main.md`](report/main.md) | **Финальный отчёт** в формате NLP_Course_Template: Abstract, Related Work, Model Description, Dataset, Experiments, Results, Discussion. Самодостаточный материал. |
| [`docs/system_design.md`](docs/system_design.md) | Цели, scope, eval-protocol, accepted decisions. §1 контекст, §2 цели/non-goals, §3 архитектура, §4 алгоритм-сводка, §5 feature-flags + ablation matrix, §6 eval design. |
| [`docs/ahc-algorithm.md`](docs/ahc-algorithm.md) | **Algorithm overview (paper-style).** Abstract + Methodology + прообразы + альтернативы + validation. Что внутри, зачем, чем вдохновлено, почему так а не иначе. |
| [`docs/design/A_ahc-algorithm.md`](docs/design/A_ahc-algorithm.md) | **Полная спецификация ядра** (операционный design-doc). §2.3 pseudocode всех модулей; §2.4 public API; §5 atomic-groups + pointer roundtrip; §9 cache-invariance contract; phase plan. |
| [`docs/decisions.md`](docs/decisions.md) | Append-only лог архитектурных решений с обоснованиями. |
| [`report/refs.bib`](report/refs.bib) | Библиография с key'ами, которые используются в `report/main.md`. |
| [`references/paper/`](references/paper/) | Прошлая работа автора (Holosophus, Borderline Accept, n=170), на которой строится AHC. |

### Код

| Путь | Что лежит |
|---|---|
| [`src/core/`](src/core/) | **Алгоритмическое ядро** (framework-agnostic): tier shaping, classifier, observer, offloader, scratchpad, recall, atomic-groups, cache-serialization. ~25 модулей с тестами. |
| [`src/adapters/ai-sdk-v6.ts`](src/adapters/ai-sdk-v6.ts) | **AI SDK v6 middleware** — точка интеграции. `createAhcMiddleware(...)` возвращает объект совместимый с `LanguageModelV2Middleware`. |
| [`src/eval/`](src/eval/) | Eval-харнесс: runner, cost tracker, persistence, статистика, per-class breakdown. |
| [`src/eval/adapters/`](src/eval/adapters/) | **Bench adapters** — по одному модулю на бенч: `assistant-traj`, `longmemeval-med`, `locomo-med`, `tau-bench-retail/`. |
| [`src/eval/baselines/`](src/eval/baselines/) | **Baselines**: `full_context`, `mastra_om`, `anthropic_compact`. |
| [`src/eval/runners/ahc_core.ts`](src/eval/runners/ahc_core.ts) | AHC core runner — wires AHC middleware к OpenRouter actor'у. |
| [`src/ui/`](src/ui/) | **Demo UI** — Next.js 16 чат с реальными tools + telemetry sidebar. |

### Данные и run output

```
benchmarks/
  assistant_traj/      # custom multimodal bench, 30 tasks + judge cache
  longmemeval/         # LME-med, 120 baked tasks (subset_ids.json frozen)
  locomo/              # LoCoMo-med, 25 tasks (subset_ids.json mirrored)
  tau-bench/           # τ-bench-retail-med, 25 episodes + env state snapshot
  runs/                # RunRecord persistence (E1 main, E2 ablations, E3 cache-hit)
eval/sweeps/           # YAML-конфиги запусков
report/figures/        # графики для отчёта
```

---

## Запуск

### Подготовка

```sh
pnpm install
cp .env.example .env       # заполнить минимум OPENROUTER_API_KEY
```

Опционально:

- `ANTHROPIC_API_KEY` / OAuth-токен / LiteLLM proxy — для Anthropic-direct baseline
  (`compact_20260112` + cache-hit subset).
- `LANGFUSE_*` — для observability traces.

Все ключи и их роли — в [`.env.example`](.env.example) с комментариями.

### Demo UI

Демонстрационный чат — самый быстрый способ потрогать AHC живьём. Next.js 16
поверх AI SDK v6 со встроенным AHC middleware, реальные tools
(`fetch_url`, `google_search`, `create_image`) и live telemetry sidebar, который
показывает в realtime: класс траектории, размер scratchpad, количество
observations, активные feature-flags, события compaction/recall/class-change,
cache-read input tokens.

```sh
pnpm dev:ui                  # http://localhost:3000
# или сборка:
pnpm build:ui && pnpm start:ui
```

UI читает `OPENROUTER_API_KEY` из `.env`. Tools rate-limited per-session.
Хороший сценарий чтобы увидеть AHC в работе — несколько turn'ов с tool-use
(«найди в интернете X, потом сделай мне картинку Y»); в правом sidebar видно,
как Tier-3 наполняется, потом часть содержимого уходит в scratchpad с
pointer-placeholder.

Дизайн UI и telemetry sidebar — [`docs/design/G_ui.md`](docs/design/G_ui.md).

### Воспроизведение результатов (eval)

Все цифры из отчёта получены одинаково: запуск **sweep**'а через `scripts/eval.ts`.

**Что такое sweep.** Это YAML-манифест, описывающий cross-product
`{benches} × {configs} × {seeds}`. Driver разворачивает его в плоский список ячеек,
прогоняет каждую через соответствующий `BenchAdapter` + `Runner` + `Grader`, и
кладёт на диск `RunRecord` per-cell. Один YAML → детерминированный набор ячеек;
seed'ы фиксированы; cost-tracker enforce'ит budget cap. Это и есть единица
воспроизводимости — `pnpm tsx scripts/eval.ts --sweep <file.yaml>` на чистом
checkout'е даёт тот же набор `RunRecord`'ов с точностью до noise самой модели.

Примеры:

```sh
# Smoke: текстовые бенчи (AT/LME/LoCoMo) через full_context, 1 task per cell
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke-4bench.yaml --max-tasks-per-cell=1

# Smoke на τ-bench: vanilla agent loop без AHC
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke-4bench-tau.yaml --max-tasks-per-cell=1

# То же, но через AHC middleware — прямое A/B сравнение
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke-4bench-tau-ahc.yaml --max-tasks-per-cell=1

# Main sweep текстовый: 4 бенча × {full_context, mastra_om, anthropic_compact, ahc_core}
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml

# Ablation grid: AHC с feature-flag разбиением
pnpm tsx scripts/eval.ts --sweep eval/sweeps/ablation_e2.yaml
```

Опции `eval.ts`:

- `--dry-run [--n-per-cell=N]` — печатает план без вызовов LLM.
- `--max-tasks-per-cell=N` — отрезает per-bench cap.
- `--concurrency=N` — параллелизм tasks (default 1).
- `--skip-auth-check` — пропустить pre-flight проверку токенов.

Результаты пишутся в `benchmarks/runs/<sweep-name>/<bench>/<config>/<seed>/run.json`.
Aggregation — `scripts/sanity-aggregate.ts`; per-class breakdown по trajectory
classes — `scripts/per-class-report.ts`; статистическая проверка дельт —
`scripts/check-run.ts`.

### Пересборка данных (опционально)

Med-subset'ы по 3 внешним бенчам уже baked и закоммичены в репо. Если нужно
пересобрать с upstream:

```sh
pnpm tsx scripts/bake-longmemeval.ts <path/to/longmemeval_s.json>   # 120 fixtures
pnpm tsx scripts/bake-locomo.ts                                      # 25 fixtures
pnpm tsx scripts/bake-tau-bench.ts                                   # env + 25 episodes
```

---

## Структура репозитория

```
src/{core,adapters,eval,ui}/         # код (Tracks A, A6, B+C+D, G)
eval/sweeps/                         # sweep YAMLs (E)
benchmarks/{assistant_traj,locomo,longmemeval,tau-bench}/   # bench data (D)
benchmarks/runs/                     # run output (E)
observability/                       # Langfuse stack (B2, opt-in)
references/                          # vendored upstream — read-only
scripts/                             # eval.ts, verify.sh, bake-*, helpers
docs/                                # system_design + per-track design + decisions
report/                              # NLP_Course final report (markdown)
```

**Dependency rule.** `core` не импортит из `adapters / eval / ui` — никогда.
`adapters → core`. `eval → core`. `ui → adapters`. Полная карта —
[`docs/system_design.md §11.6`](docs/system_design.md).

---

**Автор:** Aleksei Stepin
**Курс:** NLP, 2026 spring
