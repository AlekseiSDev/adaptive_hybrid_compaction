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

Полная библиография — [`results/<latest>/refs.bib`](results/), финальный
отчёт по работе — `results/<YYYY-MM-DD_HHMM>/results.md` (canonical
archive, см. ниже про layout). `report/main.md` — live mirror,
регенерируется на каждом ребилде; на диске есть, в git
**не отслеживается** (см. `.gitignore`).

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

MVP курсового проекта, не production paper. Phase D + Track H завершены
(сентябрь 2026): **5 bench-shape cells × 4 baselines × 3 actor providers**
(`gpt-5.4-mini` OpenRouter, `claude-sonnet-4-6` LITELLM, `gemini-3-flash-preview`
Google direct) + 3-config × 2-bench × 2-seed ablation grid. Total spend ≈ \$56.

| Контур | Что замерено | Статус |
|---|---|---|
| **Multi-turn LongMemEval** (P1, n=10–15, seed 42) | `ahc_full` 0.601 \$/task vs `full_context` 2.172 \$/task = **−72 % cost** (3.6× cheaper); accuracy 0.133 vs 0.500 — tunable Pareto trade-off via `OBSERVER_THRESHOLD` (default raised to **30000** in H Phase 8 after Mastra comparison; sweep YAML override of 4000 is a historical artefact); Observer fires **15/15** records | **Powered: AHC's principal real-world measurement** |
| **Cache stability cross-provider** (Phase D + P3 + P4) | `ahc_full` достигает 97.1 % / 98.8 % cache на single-turn LME-Med / LoCoMo-Med (60pp / 30pp выше `full_context` на том же протоколе); 49.1 % на Sonnet (LITELLM), 22.7 % на Gemini direct — verified marker round-trip | **Powered structural-shape claim** (с caveat'ом про bench protocol, см. §7.2 отчёта) |
| **Single-turn benches** (AT / LoCoMo / LME, n=20, seed 42) | Accuracy parity у всех 4 baseline'ов в пределах ±0.05 (`mastra_om` слегка edge'ит AHC на LME-Med 0.700 vs 0.650, внутри SE) | Tie; cache rate — главное наблюдаемое отличие |
| **τ-bench retail** (P2, n=30 × seeds 42/43) | `tau_bench_agent_ahc` **−12.6 % cost** vs vanilla на parity accuracy 0.100; offloader fires 0/60 — corpus shape, не bug | Cost-win + honest limitation |
| **Ablations** (P5, 3 configs × 2 benches × 2 seeds) | Observer ablation **−10pp** на LME-Med (edge of noise floor at n=20); Offloader ablation в шуме (−5pp); AT mechanism-null | Direction confirms Observer carries signal |

**Главное достижение vs prior work:**

- **vs Mastra OM** (closest analog): + Type-Aware Offloader + recall_tool + classifier; numerical parity/win on cache rate (98.8 % vs 93.6 % LoCoMo); cache invariance enforced as unit test.
- **vs Anthropic `compact_20260112`**: preserves accuracy + measurable cache reads (97 %) where compact strips them (0 %).
- **vs prior agent-generated study** (`holosophus_2026`): reproduces structural finding + adds direct cache-rate measurement + Type-Aware Offloader как answer на их open negative result.

**Самый важный honest finding:** bench-selection в этом прогоне не оптимально
exercise'ил deployment-surface AHC'а (4 of 5 cells produced `compaction_events=0`
or `offload_events=0`); только `lme-multiturn` actually fires Observer end-to-end.
Highest-priority follow-up — bench-design work (см. §7.5 отчёта + future work).

**Identified engineering improvements** (§7.6 отчёта):
1. `TIER1_INCLUDE_FIRST_USER` flag — let Observer fire on single-turn haystacks
2. `CALIBRATION_AUTO` — auto-tune thresholds
3. Lower default `T_SIZE_MIXED` for retail-scale tools
4. Multi-turn-aware classifier features

Подробнее — `results/<latest>/results.md` Abstract + §6 Results + §7.5–7.6;
полная история scope-редукций и trade-off'ов —
[`docs/decisions.md`](docs/decisions.md); audit-доки с raw numbers —
[`docs/runs/h_followup_audit.md`](docs/runs/h_followup_audit.md) и
[`docs/runs/e_sweep_audit.md`](docs/runs/e_sweep_audit.md).

---

## Где смотреть теорию и код

### Теория

| Документ | О чём |
|---|---|
| `results/<YYYY-MM-DD_HHMM>/results.{md,tex,pdf}` | **Финальный отчёт** в формате NLP_Course_Template: Abstract, Related Work, Model Description, Dataset, Experiments, Results, Discussion. Per-build snapshot — каждый rebuild создаёт новую timestamped папку. `report/main.{md,tex,pdf}` — live mirror на latest (gitignored, regeneratable). |
| [`docs/system_design.md`](docs/system_design.md) | Цели, scope, eval-protocol, accepted decisions. §1 контекст, §2 цели/non-goals, §3 архитектура, §4 алгоритм-сводка, §5 feature-flags + ablation matrix, §6 eval design. |
| [`docs/ahc-algorithm.md`](docs/ahc-algorithm.md) | **Algorithm overview (paper-style).** Abstract + Methodology + прообразы + альтернативы + validation. Что внутри, зачем, чем вдохновлено, почему так а не иначе. |
| [`docs/design/A_ahc-algorithm.md`](docs/design/A_ahc-algorithm.md) | **Полная спецификация ядра** (операционный design-doc). §2.3 pseudocode всех модулей; §2.4 public API; §5 atomic-groups + pointer roundtrip; §9 cache-invariance contract; phase plan. |
| [`docs/decisions.md`](docs/decisions.md) | Append-only лог архитектурных решений с обоснованиями. |
| `results/<latest>/refs.bib` | Библиография с key'ами, которые используются в `results/<latest>/results.{md,tex}`. |
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
benchmarks/runs/                     # run output — local-only, gitignored
observability/                       # Langfuse stack (B2, opt-in)
references/                          # vendored upstream — read-only
scripts/                             # eval.ts, verify.sh, bake-*, helpers
docs/                                # system_design + per-track design + decisions + runs/audits
results/<YYYY-MM-DD_HHMM>/           # per-build report snapshots — committed archive
report/                              # live working mirror — gitignored (regeneratable)
```

**Dependency rule.** `core` не импортит из `adapters / eval / ui` — никогда.
`adapters → core`. `eval → core`. `ui → adapters`. Полная карта —
[`docs/system_design.md §11.6`](docs/system_design.md).

---

**Автор:** Aleksei Stepin
**Курс:** NLP, 2026 spring
