# System Design — AHC (Adaptive Hybrid Compaction)

Документ описывает цели, scope, eval-protocol и план поэтапной реализации middleware
для context compaction на medium-distance траекториях агентских ассистентских систем.
Контрибьюция — гибрид task-aware и type-aware policies поверх Mastra-inspired 3-tier
append-only shape, с lightweight trajectory classifier для routing.

Алгоритмическое ядро (модули, pseudocode, инварианты) — см. `design/A_ahc-algorithm.md`.

---

## Meta

**Author:** Aleksei
**Date Created:** 2026-05-11
**Status:** Draft
**Format target:** Курсовой проект в формате NLP_Course_Template — фреймворк может стать
основой для дальнейшего paper'а, но MVP scope — отчёт курса.

---

## 1. Контекст

### 1.1 Терминология

Закрепляется во всём проекте (детали — в `design/A_ahc-algorithm.md §1`):

- **Trajectory** — вся session от первого user message.
- **Turn** — одна (user message → assistant final response) пара. Снаружи это один request
  и один response, внутри может быть много action.
- **Step** — атомарное действие внутри turn (один LLM call ИЛИ одна tool execution).
  Один turn может содержать 1–10 steps, в tool-heavy случаях — до десятков.
- **Medium trajectory** — наш target: 5–15 turns, что соответствует ~20–80 steps. На long
  траекториях (15+ turns, 100+ steps) AHC должен **работать без значимой просадки**,
  но оптимизация под этот режим — non-goal v1.

### 1.2 Проблема

На medium-distance траекториях (5–15 turns) ассистентов с tool-use существующие подходы
к compaction систематически проигрывают по одному из критериев. Mem0/Letta/Zep оптимизированы
под cross-session memory и избыточны на одной сессии. LLMLingua и rolling-window не учитывают
структуру (tool_use/tool_result atomic pairs, query-relevance). Native provider compaction
(Anthropic `compact_20260112`) теряет tool outputs — измерено в codex#14589: tool_results
≈ 79% сессионных токенов и 0% выживает после двух компакций.

### 1.3 Предшествующая работа и предварительные сигналы

Существующее агент-сгенерированное исследование (paper.pdf, peer review Borderline Accept,
n=170) дало **предварительные сигналы** — paper писал и оценивал агент без полного
human-controlled review, поэтому числа берём как направление, не как ground truth:

- Task-aware вероятно доминирует full-context на LongMemEval/LoCoMo по accuracy при ~2%
  токенов от full-context.
- Task-aware вероятно катастрофически проваливается на τ-bench retail (pass@1 ≈ 0).
- Type-aware ведёт себя обратно: ок на τ-bench, слабо на text-only.

Эти сигналы используются как **исходная гипотеза** для архитектурного выбора AHC; финальные
числа на нашем сетапе мы получим заново и считаем authoritative.

**Eval-axes framing.** Эти three гипотезы описывают разные compaction failure modes,
изолированные разными бенчами: LongMemEval / LoCoMo тестируют **passive-recall axis**
(1-turn QA с compaction над длинной history), τ-bench — **agentic-state axis**
(live tool loop с compaction между steps), AssistantTraj — **trajectory-coherence
axis**. Все 4 бенча — compaction benchmarks (не «agent loop frameworks» per se).
Bench-role table + adapter contract implications: `design/D_assistant-traj.md §9`.

### 1.4 Что мы строим

AHC — middleware совместимый с **Vercel AI SDK v6**, который классифицирует trajectory
class на лёгкой эвристике и применяет соответствующую compaction policy. Идейно
framework-agnostic (core отделён от AI-SDK обёртки), но primary integration target — AI
SDK v6 с его custom tools API. Адаптеры под Mastra/raw Anthropic SDK — **out of MVP**.
Базовая 3-tier архитектура (const/append-only/mutable) заимствована из Mastra OM —
cache-invariant by construction.

---

## 2. Цели

### 2.1 Goals

- **Robustness across classes** — AHC не разваливается на любом trajectory class.
  Конкретно: на тех бенчах где single-policy показывает 0% accuracy, AHC даёт ≥ 50% от
  best single-policy baseline на этом же бенче.
- **Cost-quality Pareto** — AHC Pareto-доминирует ≥ 1 baseline по парe (accuracy × $ per task)
  на каждом из 4 бенчей. Конкретные пары:
  - LongMemEval-Medium: accuracy at K-th percentile vs $/task
  - τ-bench retail: pass@1 vs $/task
  - AppWorld normal: state-match vs $/task
  - AssistantTraj: composite (LLM-judge score + exact-match where applicable) vs $/task
- **Cache-friendly** — prompt-cache hit rate ≥ 60% на medium-traj measured on Anthropic
  direct API (cache hit rate как метрика — Anthropic-specific, см. §6.3).
- **AI SDK v6 совместимость** — работает как middleware над AI SDK v6 Agent class с
  custom tools, без модификации пользовательского кода.
- **Zero-config** — всё работает на defaults, калибровка ≤ 10 трасс простого формата, opt-in.
- **Reproducible ablations** — каждая фича через feature-flag, ablation grid часть отчёта.

### 2.2 Non-Goals

- Не делаем cross-session memory (домен Mem0/Letta/Zep).
- Не делаем personalization (working memory с user facts).
- Не делаем fine-tuning или RL обучение собственных компакторов.
- Не делаем prompt-level token compression (LLMLingua territory).
- Не packaging как npm пакет на MVP (но code должен быть готов к этому).
- Не делаем production-grade SDK с auth/multi-tenancy/observability — это research middleware.
- Не оптимизируем под long-horizon (15+ turns, 100+ steps) — должно работать без просадки,
  но best-on-that-regime — не цель.

### 2.3 Success Criteria

Финальная таблица результатов содержит AHC и 4 baselines на 4 бенчмарках. AHC показывает:
- На каждом бенче — Pareto-доминирование ≥ 1 baseline по (accuracy × cost)
- Recovery τ-bench accuracy от ~0 (single task-aware) до приемлемого уровня (≥ 0.5)
- Cache hit rate ≥ 60% где замерено
- Ablation grid (3 configs) подтверждает что compaction компоненты контрибьютят

Числа statsig: paired permutation p < 0.05 на главных дельтах, replication через 2 seeds.

Минимальная beta-версия (если scope придётся ужать): AHC + 3 baselines на 3 бенчмарках.

---

## 3. Архитектура

### 3.1 3-tier shape (inspired by Mastra OM)

```
[ Tier-1: const prefix ]            ← immutable: system + tools + first user msg
[ Tier-2: append-only observations ]← растёт только в конец, cache-friendly
[ Tier-3: mutable recent K turns ]  ← hot context, mutates каждый turn
```

Cache breakpoint — в конце Tier-1. Tier-2 содержит и task-aware extractions, и
type-aware pointers (offloaded tool_result placeholders), и trajectory class signal.
Это инвариант данных, не оптимизация — нарушение = bug.

### 3.2 Логические модули

Полный список с pseudocode — `design/A_ahc-algorithm.md §2.3`. Сжатый перечень:

- **Trajectory Classifier** — feature-based routing (`conversational | tool_heavy | mixed`)
- **Task-Aware Observer** — query-anchored extraction, async buffer
- **Type-Aware Tool Offloader** — atomic groups → pointer + scratchpad
- **Scratchpad Store** — in-memory `Map<group_id, full_result>` (MVP)
- **Recall Tool** — `recall_tool_result(id)` инжектируется когда есть offloaded
- **Async Buffer** — pre-emptive observation generation, Mastra-style activation hooks
- **Reflection Layer** — редкое deep recompression Tier-2 (cache-killer, но opt-in включён)

### 3.3 Где живёт tool compaction

Прямой ответ на вопрос «Observer/Reflector компактит tool outputs?» — **нет, для tool
outputs у нас отдельный механизм (Type-Aware Offloader)**. Архитектурно это два разных
слоя с разными triggers:

- **Observer/Reflector** работают над Tier-2 (observation log) — это extracted facts/events.
  Они никогда не трогают tool_result-байты напрямую.
- **Type-Aware Offloader** работает над Tier-3 (mutable recent) — над raw tool_result.
  При превышении threshold вытаскивает оригинал в scratchpad и подменяет на pointer.

Pointer-placeholder из Type-Aware попадает в Tier-2 при clip'е Tier-3, и дальше Observer
может видеть pointer и при необходимости решать что-то о его контексте — но **не**
рекомендовать recall (recall решает агент сам через recall_tool_result tool).

Это и есть «tool compaction из коробки» — он включён в `TYPE_AWARE_OFFLOAD=true` default.

### 3.4 Cache invariance contract

Жёсткий инвариант, проверяемый unit-тестом:

```
∀ turn i: bytes(Tier-1 + Tier-2_stable)_{turn_i} == _{turn_{i-1}}
where Tier-2_stable = Tier-2 up to last reflection event
```

Reflection — единственная operation которая нарушает contract, и она наблюдаемая
(logged + measurable, редко триггерится).

---

## 4. Алгоритм AHC (сводка)

Детали — `design/A_ahc-algorithm.md`. Здесь — операционная сводка для понимания scope:

- **Classifier** — feature-based rules, без LLM call. Фичи: tool_call_density,
  avg_tool_result_size, recent_tool_density, user_turn_ratio, multimodal_flag.
- **Conversational policy** — task-aware Observer вытаскивает query-anchored
  observations из Tier-3 в Tier-2 при превышении 8K tokens; Tier-3 clip'ается с retention 20%.
- **Tool-heavy policy** — atomic group detection; tool_results > 4KB (или cumulative >
  24KB) offload'ятся в scratchpad с pointer replacement; recall tool инжектируется.
- **Mixed policy** — обе работают одновременно с дифференцированными thresholds.
- **Calibration** — opt-in, тюнит thresholds на ≤ 10 трассах с known outcomes.

### Что значит «conversational» и почему термин нужен

`conversational` — это **trajectory class**, не свойство одного сообщения. Это вся
session с низкой tool-call density (медиана < 0.3 tool calls per turn), доминируют
user-assistant exchanges, типично для long-term memory задач. Противоположность —
`tool_heavy` (≥ 1.5 tool calls per turn, action-driven, characteristic для τ-bench
и AppWorld). `mixed` — где density меняется по ходу trajectory.

---

## 5. Feature flags и ablation matrix

### 5.1 Flags

| Flag | Default | Что выключает |
|---|---|---|
| `TASK_AWARE_EXTRACTION` | true | Query-anchored Observer (conv branch) |
| `TYPE_AWARE_OFFLOAD` | true | Tool_result pointer-offload + scratchpad (tool branch) |
| `TRAJECTORY_CLASSIFIER` | true | Adaptive routing (fallback на configured class) |
| `ASYNC_OBSERVER` | true | Фоновая буферизация (fallback sync compaction) |
| `RECALL_TOOL` | true | Инъекция `recall_tool_result` tool |
| `SCHEMA_AWARE_DIGEST` | false | Schema-projection при наличии tool schema |
| `REFLECTION` | true | Deep recompression Tier-2 (opt-in включаем по умолчанию) |
| `CALIBRATION_AUTO` | false | Авто-калибровка thresholds на target traces |

### 5.2 Ablation grid

Минимальный grid для отчёта (запускается на 2 ключевых бенчах — LongMemEval-Medium и
AssistantTraj):

| Config | Описание |
|---|---|
| `AHC-full` | Все flags default ON |
| `AHC-task-only` | `TYPE_AWARE_OFFLOAD=false`, `RECALL_TOOL=false` |
| `AHC-type-only` | `TASK_AWARE_EXTRACTION=false` |
| `AHC-no-classifier` | `TRAJECTORY_CLASSIFIER=false`, force `mixed` |

---

## 6. Eval design

### 6.1 LLM provider и модели

- **Provider**: OpenRouter для всех experiments (единый ключ, единый billing).
- **Primary actor model**: `openai/gpt-5.4-mini` — main experiments. Pricing snapshot
  2026-05-13: $0.75 in / $4.50 out per 1M tokens. **Выбран намеренно за automatic
  prompt caching** на OpenRouter — OpenAI кеширует префикс при ≥1024-token prompt'е
  без explicit `cache_control` (как у Anthropic). Проверено live (`scripts/probe-openai-cache.ts`,
  decisions 2026-05-13): на ~3340-token system prompt'е cached_tokens flips 0 → 2304
  (80.8% hit) на calls 2-3, latency 903ms cold → ~500ms warm. AHC telemetry
  (`src/eval/telemetry.ts:42-49`) уже маппит `prompt_tokens_details.cached_tokens` →
  `cache_read_input_tokens` в NDJSON.
- **Secondary actor model**: `google/gemini-3-flash-preview` — для cross-vendor sanity
  на small subset, если budget позволит.
- **Judge model для LLM-judge eval**: `anthropic/claude-sonnet-4.6` via OpenRouter
  (capable, используется только для финальной оценки).
- **Cheap models для AHC internals** (Observer, digest gen, classifier): тот же
  `openai/gpt-5.4-mini` по умолчанию — кэширование амортизирует Observer/digest cost
  внутри сессии. В production можно конфигурировать (Mastra-style `ModelByInputTokens`).

**Caching prerequisite**: чтобы automatic cache fired надо emit **stable, ≥1024-token
system prompt**. Минималистичный `'You are a helpful assistant. Answer concisely.'`
(~7 words) — не подходит; harness вешает enlarged system prompt (см.
`src/eval/runners/ahc_core.ts` / `src/ui/lib/systemPrompt.ts` integration).

**Cache hit rate cross-check**: дополнительный small subset (n=10–15) через **direct
Anthropic API** c Sonnet-4.6 остаётся в плане (E3) для cross-vendor validation, но
primary cache numbers теперь приходят с OpenRouter+OpenAI пути.

### 6.2 Бенчмарки

| Бенчмарк | Фильтр | n | Назначение |
|---|---|---|---|
| **LongMemEval-Medium** | `haystack_sessions ≤ 3` | 60 (seed 42) + 30 (seed 43) replication | Conversational long-term memory |
| **LoCoMo-Medium** | Первые 8 sessions каждого диалога | 20 | Conversational temporal |
| **τ-bench retail (medium)** | tasks с optimal path 5–15 actions | 25 | Tool-heavy агентский |
| **AssistantTraj** | новый бенч (см. §6.3) | 30–40 | Multimodal ассистентский |

LongMemEval-Medium и LoCoMo-Medium частично переиспользуют harness из существующего paper.
Размеры n меньше чем в paper (60+30 вместо 120+50) — это NLP-course scope, не paper scope.

**Per-bench pipeline** для всех 4 бенчей следует upstream Python harness pattern
(`references/mle-harness/code/run_*.py`): `long history → compaction strategy →
driver-LLM call → judge`. То есть каждый бенч — compaction-quality test, а не
agent-loop test. AHC adaptive classifier маршрутизирует per-bench compaction
policy. Per-bench eval axis + adapter contract implications (`prepare()` возвращает
FULL long history, compaction = baseline-layer concern): `design/D_assistant-traj.md §9`.

### 6.3 AssistantTraj — кастомный benchmark

Главный новый артефакт работы — реалистичный ассистентский benchmark с multi-modal
содержимым. Главные источники трасс:

1. **Реальные production traces** из 2D-canvas рабочего проекта (basis). Aleksei отбирает
   и анонимизирует.
2. **Open-source assistant benchmarks как secondary** — если есть подходящие c free license
   на medium-traj (ищем в фазе D1).
3. **Synthetic top-up** если #1 и #2 дают < 30 трасс.

Целевые категории — балансированные:
- Image-grounded Q&A (upload + multi-turn вопросы): ~8
- Code generation + iteration (file read tools + написание кода + правки): ~8
- Research-then-write (search/fetch + synthesis + follow-up): ~8
- Mixed assistant flow («найди инфо по этой картинке, потом код, потом проверь»): ~6–16

**Eval format**: точные ответы — exact-match; нечёткие — LLM-judge (GPT-5.4) с rubric;
sample 10% — human-verify для калибровки judge bias.

### 6.4 Метрики

- **Accuracy** — per-bench (exact-match, F1, или LLM-judge с rubric для AssistantTraj).
- **Tokens per turn** — input + output, average и p95.
- **Prompt cache hit rate** — Anthropic-specific, замер на subset через direct API.
- **$/task** — derived из (tokens × OpenRouter prices).
- **p95 latency** — wall-clock от user message до final response.
- **Recall tool usage rate** — % task'ов где агент вызвал `recall_tool_result` ≥ 1 раз.
- **Per-class accuracy breakdown** — для AHC показать как accuracy зависит от detected class.

### 6.5 Baselines

| # | Baseline | Источник |
|---|---|---|
| 1 | Full context | Upper-bound accuracy, load sanity |
| 2 | Anthropic native `compact_20260112` | Server-side провайдер |
| 3 | Mastra OM (default config) | **Main competitor**, проверяем за паритет |
| 4 | **AHC** | Proposed |

Сокращено с 8 до 4: дропнули sliding window (слишком naive), Mem0 (нет готовой AI SDK
v6 интеграции, прогать ради этого нет времени — числа из существующего paper цитируем
в Related Work), LLMLingua-2 (вне scope), old task-aware/type-aware (existing paper
numbers процитированы; повторно интегрировать ради сравнения — overhead).

---

## 7. План реализации

### 7.1 Параллельные треки

Реализация структурирована так, чтобы треки шли параллельно без блокировок:

- **Track A** — Core algorithm (блокирует только финальные runs)
- **Track B** — Eval harness extension + observability (Langfuse) (старт day 1)
- **Track C** — Baselines integration (старт day 1)
- **Track D** — Custom benchmark construction (старт day 1)
- **Track E** — Main runs (требует A + B + C + D)
- **Track F** — Course report writing (требует E)
- **Track G** — Demo UI (требует Track A полностью + B2 telemetry; параллелится с E/F)
- **Track H** — Follow-up sweeps (cross-model / multi-seed / ablations / activation gates) — extends E, blocks F-report numbers beyond single-seed headline. См. `docs/design/H_ablations_and_TODOs.md`; numbers в `docs/runs/baselines_frozen.md` (Cross-bench ablations section + text-bench caveats), open workstreams в `docs/runs/current.md` Track H.
- **Track I** — `mastra-agent` baseline (full Mastra Agent + tools) — additive baseline closing tau-bench framework-native gap (vanilla `tau_bench_agent` vs `tau_bench_agent_ahc` had no industry-standard agentic competitor). Parallel to E/H; produces cross-framework Pareto row для F-report. См. `docs/design/I_mastra_agent.md`.
- **Track J** — AssistantTraj v2 (tool-grounded, n=50). AT-v1 (30 text-only) retire; mocked 4-tool palette (`image_gen`, `google_search`, `web_fetch`, `code_interpreter`); fixture-replay default, live за `AT_TOOL_MODE=live` (запрещён в CI). Adds tool-call coherence axis к AT (sister-метрика к content-quality). Source seed — jay-canvas e2e golden-set. Параллелится с E/H/I; cutover sweep YAML row меняется в J6. См. `docs/design/J_at_tools.md`.
- **Track K** — `gaia-med` bench (cross-domain agentic, n=30 stratified). GAIA (Mialon et al. 2023, CC BY) — пятый bench в evaluation-протоколе, закрывает gap в agentic axis: tau-bench-retail-med узко-доменный (retail / 10 tools), GAIA cross-domain (research + web + code + multimodal, 5-tool surface). Knowledge accumulation between tool calls — другая нагрузка на observer / offloader чем env-state tau. Local snapshot из neighbour Holosophus (`/Users/Aleksei/Projects/ai_scientists/Holosophus/holosophos/evals_and_reports/data/`) → vendored в `references/gaia/`. Wall-clock ~6-7 дней; параллелится с E/H/I/J. См. `docs/design/K_gaia.md`.

### 7.2 Phase schedule с описанием шагов

**Track A — Core implementation**

- **A1. 3-tier shape + atomic groups + feature flag scaffolding (3 дня).**
  Реализуем core data structures: Tier1/2/3 separation, atomic group parser
  (tool_use+tool_result+optional reasoning), feature flag config object. Pure data
  manipulation, no LLM calls. Unit tests на atomic group correctness.

- **A2. Type-Aware Offloader + Scratchpad + Recall Tool (3 дня).** Имплементируем
  offload decision logic с T_SIZE/T_CUM thresholds, scratchpad как in-memory Map,
  digest generation (LLM-based + rule-based fallback), Recall Tool definition и
  injection logic. Тесты на cache invariance после offload.

- **A3. Task-Aware Observer + observation log (3 дня).** Observer prompt и flow,
  query-anchored extraction, append-only log structure, post-extraction tail clip с
  bufferActivation=0.8. Sync version сначала, async wrapper в A5.

- **A4. Trajectory Classifier (2 дня).** Feature extractor (incrementally computed),
  rules-based classification с hysteresis, опциональный calibration hook. Unit tests
  на ground-truth трассы с known classes.

- **A5. Async Buffer + Reflection Layer (2 дня).** AsyncBuffer для pre-emptive Observer
  runs, activation hooks (activateAfterIdle, blockAfter), Reflection trigger логика и
  reflector LLM prompt. Async-aware tests.

- **A6. AI SDK v6 middleware adapter (2 дня).** Обёртка core логики в
  `LanguageModelV2Middleware`-совместимый API. **Surface** (предположительный, требует
  верификации в день старта против актуального v6 release notes):
  - Hook `transformParams` — точка интеграции; core.compact(messages, ctx) возвращает
    modified messages-array до отправки в provider.
  - Recall Tool инжектируется через extension `tools` массива в `transformParams`,
    когда `scratchpad.size() > 0`. Tool definition стабильна → не ломает cache prefix.
  - `wrapStream` пропускает stream без модификации — compaction уже сработала до stream.
  - Scratchpad живёт в closure адаптера, persistent across calls в рамках одной session;
    session boundary определяется вызывающим (AI SDK v6 Agent class).
  - Tool_use_id tracking — атомарные группы строятся по этим id, как в §5.1 algorithm doc.

  **Investigation prerequisite**: перед A6 — короткая investigation
  (`docs/investigations/ai-sdk-v6-surface.md`), проверяющая что v6 stable expose'ит эти
  hooks в ожидаемой форме; если surface поменялся, ревизим scope A6 до фактической интеграции.
  E2e test с toy агентом + custom tool — exit criterion.

**Track B — Eval harness**

- **B1. Wire existing harness (1 день).** Portировать harness из vendored snapshot
  `references/mle-harness/code/` в `src/eval/` — что есть переиспользуем, расширения
  под AHC-specific метрики.

- **B2. Telemetry + Langfuse + LLMClient + ships `full_context` (3-4 дня — extended
  per `decisions.md 2026-05-13`).** Расширен от исходных 2 дней по explicit user choice:
  - Telemetry pipeline (`cache_read_input_tokens`, `compaction_events`, `recall_events`,
    `class_signal` в `TurnRecord`); `ProviderUsageMapper` для OpenRouter + Anthropic shapes.
  - `Baseline` interface (per `design/C_baselines.md §1`) + `buildRunnerFromBaseline`
    helper — мост между per-turn baselines и outer Runner (B1).
  - `LLMClient` + OpenRouter raw fetch wrapper (`src/eval/llm.ts`); pricing snapshot const.
  - `full_context` baseline (`src/eval/baselines/full_context.ts`) ships in B2 inline —
    де-факто закрывает Track C C3 (см. Track C ниже).
  - **CostTracker активирован** в `runSweep` (не каркас): observe + shouldHalt по 1.5×
    projected budget после 20 tasks, halt = clean break + resumable.
  - **Full OpenTelemetry pipeline**: `@langfuse/otel@^5.3.0` (v5 SDK rewrite —
    supersedes deprecated `langfuse-vercel`); `LangfuseSpanProcessor` attach'ится
    при `LANGFUSE_ENABLED=true`, иначе NoopTracerProvider (нулевой overhead).
    Spans: `eval.sweep` / `eval.config_seed` / `eval.task` / `eval.turn`.
  - **Out:** `ahc_core` runner — deferred to A6 / отдельная фаза (single integration
    path через `createAhcMiddleware`, не eval-side mini-adapter).

- **B3. Per-class breakdown reporting (1 день).** Скрипт, который для AHC показывает
  accuracy split по detected trajectory_class — это важно для Discussion в отчёте.

- **B4. End-to-end Langfuse vertical-slice verification (0.5 дня).** Поднимаем
  локальный Langfuse stack через `observability/docker-compose.yml` (zero-touch
  bootstrap через `LANGFUSE_INIT_*` env vars — admin user/org/project/API keys
  pre-created на старте); прогоняем real OpenRouter+Gemini smoke с
  `LANGFUSE_ENABLED=true`; `scripts/check-langfuse-hierarchy.ts --mode=count` через REST API
  верифицирует что ≥ 1 trace доехал в Langfuse. Programmatic acceptance gate
  для §9 pipeline. Real-run артефакты не коммитятся (validation step, не
  reproducibility evidence). См. `decisions.md 2026-05-13` B4 entries.

- **B5. AHC runtime integration (1 день).** Real `ahc_core` runner в
  `src/eval/runners/ahc_core.ts` — `wrapLanguageModel({model, middleware})`
  поверх AI SDK v6 provider (`@ai-sdk/openai` configured for OpenRouter) +
  `createAhcMiddleware` (A6 adapter); `generateText({experimental_telemetry:
  {isEnabled, functionId:'ahc.step'}})` для auto-spans. Cost-aware LLMCaller
  wrapper учитывает digest/observer/reflection LLM-вызовы в `step.cost_usd`.
  Per-task `eval.task` span (для всех configs — landed в Commit A) +
  child `ai.generateText` spans (для ahc_core). Заменяет `noop_ahc` stub из
  B1 в `ahc_flags`-driven configs; `baseline: noop_ahc` остаётся explicit
  fallback для offline smoke без API key.

- **B6. Langfuse session/trace/span hierarchy + verification (1.5 дня).**
  До B6 telemetry была одной плоскостью: `eval.sweep` (root) → `eval.task`
  (per-sample child) → auto-`ai.generateText.*` от AI SDK; всё попадало в
  один gigantic trace на весь sweep, `langfuse.session.id` не ставился вообще,
  multi-turn benches схлопывались в одну `eval.task`. B6 выравнивает иерархию
  под Langfuse session/trace модель:
  - **session** = `${bench}-${config_id}-${seed}` (ячейка sweep'а) — атрибут
    `langfuse.session.id` на каждом `eval.task` span.
  - **trace** = один task — `eval.task` стартует с `ROOT_CONTEXT` (parent link
    к `eval.sweep` разорван); `eval.sweep` остаётся отдельным standalone trace
    с aggregate metadata.
  - **spans** = `eval.turn` per `baseline.step()` (multi-turn benches:
    `lme-multiturn`, `tau-bench-retail-med`, `assistant-traj`) + AI SDK
    auto-emitted `ai.generateText.*` + `ai.toolCall` как children (наследуют
    через OTel context — не пишем custom `ToolCallEvent` instrumentation).
  - **Verification** — `scripts/check-langfuse-hierarchy.ts` (rename из
    `check-langfuse-trace.ts`) fetch'ит `/api/public/sessions|traces|observations`,
    assert'ит nested структуру. 3 smoke sweep'а (`gaia-med`, `lme-multiturn`,
    `assistant-traj`, n=3 each) + playwright_mcp UI nav на :3001 — manual gate.

**Track C — Baselines integration**

- **C1. Mastra OM baseline (2 дня).** Поднять Mastra с default config (PG storage,
  observational memory enabled), интегрировать в общий eval harness. Это main competitor.

- **C2. Anthropic native compact wrapper (1 день).** Wrapper над Anthropic Messages API
  с `compact_20260112` strategy, чтобы прогонять в том же harness.

- ~~**C3. Full context baseline (0.5 дня).**~~ **Ships in B2** (см. `decisions.md 2026-05-13` B2 entries):
  тривиальный wrapper без компакции для upper-bound; реализован в `src/eval/baselines/full_context.ts`
  с использованием B2 `LLMClient`. Track C wall-clock сократился 3.5 → 2.5 дня.

**Track D — Custom benchmark construction**

- **D1. AssistantTraj design + JSON schema (2 дня).** Финализировать категории (8/8/8/14),
  схему задач (input messages, expected outputs, eval rubric), tooling skeleton.

- **D2. Сбор jay-canvas-seeded + open-source трасс (3 дня).** Импорт scenarios из
  jay-canvas golden-set (синтетические e2e фикстуры, нет PII) через
  `scripts/import-jay-canvas.ts`, hand-extend до medium-traj 5–15 turns.
  Параллельно поиск open-source benches. §4 anonymization protocol
  superseded — см. `decisions.md [2026-05-13]`.

- **D3. Synthetic top-up + manual review (3 дня).** Если real + open-source < 30 трасс
  — догенерация через Sonnet с разнообразными prompts; 100% manual review каждой трассы
  (5–10 мин на трассу).

- **D4. Eval adapter + LLM-judge rubrics (2 дня).** Adapter для AssistantTraj в общий
  harness, написать judge prompts для каждой категории, calibration sample (10% human-verify).

- **D5. Other-bench ports (3 дня).** Порт TS BenchAdapter'ов для LongMemEval-med /
  LoCoMo-med / tau-bench-retail-med из `references/mle-harness/code/run_*.py`.
  Per-bench grader (longmemeval exact-string recall; locomo semantic; tau-bench
  task-completion + tool-sequence). Task fixtures под `benchmarks/<bench>/`.
  Регистрация в `defaultAdapterRegistry`. **Минимальная beta floor** (§9): 3
  бенча — AssistantTraj + 2 из этих трёх; полные 4 — stretch. tau-bench heaviest
  (agentic tooling); допустимо отложить если порт дороже 1 дня.

**Track E — Main runs**

- **E1. Sweep всех 4 baselines × 4 бенчей (3 дня wall-clock).** На OpenRouter+Gemini-3.1-Flash,
  с replication seed. Бюджет ~$80–120 (грубо: 4×4×~80 задач × $0.05/задача).

- **E2. Ablation grid (4 configs × 2 benches) (1 день).** AHC variants на ключевых
  бенчах. ~$30.

- **E3. Cache hit rate subset (0.5 дня).** n=10-15 через Anthropic direct API, Sonnet-4.6.
  ~$20.

**Track F — Course report.** Primary deliverable — `report/main.md` (submission-grade
markdown по NLP_Course_Template секциям; templates в `docs/templates/NLP_Course_Template.{pdf,tex}`).
LaTeX path (`report/main.tex` по .tex template) — optional в F3 при наличии buffer.
Prev paper cite source: `references/paper/` + `docs/templates/prev_paper/result.md`
headline-summary, **с provenance disclosure** (fully agent-generated, без human review;
см. `design/F_report.md §4.1`). Подробности — `design/F_report.md`.

- **F1. Структура отчёта по NLP_Course_Template (2 дня).** Заполнить секции (Intro,
  Related Work, Model Description с references на design/A_ahc-algorithm.md, Dataset, Experiments,
  Results, Conclusion). Главная Results таблица. Mapping 1-в-1 на template секции —
  `design/F_report.md §2`.

- **F2. Figures + discussion (2 дня).** Pareto plot per benchmark, per-class breakdown bar
  chart, ablation comparison. Discussion section с честным анализом negative results если есть.

- **F3. Финальный pass + полировка (1 день).** Корректура, refs.bib, проверка терминологии,
  reproducibility appendix. Optional latex path: `report/main.tex` build из md содержания
  по template, `latexmk -pdf` clean.

**Track G — Demo UI**

- **G1. Skeleton + AI SDK v6 chat (1 день).** Next.js App Router app в `src/ui/`.
  `useChat` hook на OpenRouter provider, text + image URL input, multi-turn без AHC.
  Минимальный agent-каркас: hardcoded system prompt (research-assistant role),
  `maxSteps:8` agent loop через AI SDK v6 — tools ещё нет, single LLM call per turn.
  AI SDK v6 UI helpers — часть `ai-sdk-v6-surface` investigation (A6 prerequisite).
  Exit: chat работает end-to-end через UI. Детали — `design/G_ui.md §1, §4 G1`.

- **G2. AHC integration (1 день).** Mount AHC middleware в `/api/chat` route. Per-session
  scratchpad lifecycle (in-memory `Map<sessionId, Scratchpad>`, TTL 1ч idle). Feature flags
  читаются из query params для quick toggling. Один real tool — `fetch_url(url) → string`
  (server-side fetch + html-to-text) — большой tool_result делает AHC offload видимым;
  без tools Tier3 пустой и демо бесмысленно. Exit: AHC active в demo runs, recall работает.

- **G3. Telemetry sidebar (1 день).** Backend injects AHC stats в response envelope;
  frontend sidebar показывает live class, observations, scratchpad size, recall events,
  current flags. Consume'ит тот же telemetry поток, что Langfuse (Track B). Exit: видно
  как AHC компактит во время real conversation.

**Track I — `mastra-agent` baseline.** Additive baseline — Mastra `Agent` с
зарегистрированными tools и native multi-step loop. Прогон по 3 mt-style бенчам
(`assistant-traj`, `lme-multiturn`, `tau-bench-retail-med`). Closes tau-bench
framework-native competitor gap (до Track I на tau стояли только `tau_bench_agent`
vanilla + `tau_bench_agent_ahc`). Wall-clock ~4 дня, бюджет $20-31. Подробности —
`docs/design/I_mastra_agent.md`.

- **I1. Mastra Agent text-bench scaffold (1 день).** `mastraAgentBaseline` в
  `src/eval/baselines/mastra_agent.ts` — `Baseline` impl c Memory + LibSQL +
  OpenRouter wire, копирует shape `mastra_om.ts`, но `agent.generate()` принимает
  `tools` параметр (пустой для text-bench, готов к I2). Registered в runner
  registry. TDD: unit tests + live smoke на 1 lme-multiturn task (cost > 0,
  input_tokens > 0).
- **I2. Tau-bench Mastra adapter (2 дня).** Step 0 investigation
  `docs/investigations/mastra-tools-api.md` (Mastra tools API shape).
  `runTauEpisodeMastra` в `src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts`
  — mirror `runTauEpisode` без AHC middleware. `aiSdkToolToMastra(name, tool)`
  translator для 10 retail tools, closures over `envState` сохраняются. TDD:
  unit на translator + live smoke 1 retail episode с ≥1 mutating tool call.
- **I3. Sweep run + audit (0.5 день).** `eval/sweeps/main_e1_mastra_agent.yaml`
  (3 bench × seed=42, $30 budget) + `eval/sweeps/smoke_mastra_agent.yaml`.
  Числа per bench + сравнение vs `mastra_om` (chassis consistency) + vs
  `tau_bench_agent_ahc` (main insight) лягут в `docs/runs/baselines_frozen.md`
  (Track I rows + Tau-bench section).

**Track J — AssistantTraj v2 (tool-grounded, n=50).** Замена AT-v1 30 text-only
задач на 50 tool-grounded с обязательным ≥1 tool-call per task. 4-tool palette
(`image_gen` / `google_search` / `web_fetch` / `code_interpreter`), fixture-replay
дефолт (cache-invariant A/B), live за `AT_TOOL_MODE=live` (CI guard throws).
Wall-clock ~8 дней, бюджет ≤$5 (J6 smoke). Source — jay-canvas e2e golden-set.
Подробности — `docs/design/J_at_tools.md`.

- **J1. Schema patch + cross-field rule (1 день).** Расширение
  `AssistantTrajTaskSchema` с superRefine `tools_available ↔ expected_tool_calls.required`,
  новый `ToolFixtureFileSchema` (sidecar), `tool_fixtures_ref?` optional поле. Type
  plumbing в `src/eval/types.ts`: `Conversation.tools?`, `Score.tool_coherence?`,
  `RunnerResponse.toolCalls?`. Один новый valid + один invalid fixture (D1 pattern).
  Existing 30 AT-v1 tasks должны продолжать parse'иться (rule применяется только
  когда `expected_tool_calls` непустой).
- **J2. Tool runtime + baseline forwarding (2 дня).**
  `src/eval/adapters/assistant-traj.tools.ts` — 4 `tool()` defs + `ReplayDispatcher`
  (default) + `ToolReplayMissError`; `tools-live.ts` (lazy) — OpenAI Images /
  Brave / fetch+readability / pyodide. CI guard. Forward `conv.tools` через
  `baseline.ts` + 4 baselines (`full_context`, `anthropic_compact`, `mastra_om`,
  `mastra_agent` — последний pre-wired для tools? в deps, нужно дотянуть до
  `agent.generate`). `RunnerResponse.toolCalls` собираются из provider response.
- **J3. Corpus port + AT-v1 retire (1.5 дня).** Extend existing
  `assistant-traj.import.ts`: map jay-canvas tool names в нашу 4-палитру, DROP
  out-of-palette, emit paired `tool_fixtures/<id>.json`. Hand-extend turns до
  5–15 (D §3.1 carried). `scripts/import-jay-canvas-tools.ts` — thin CLI runner.
  `git rm` AT-v1 30 task files + AT-v1 attachments одним коммитом.
- **J4. Synthetic top-up to n=50 (1 день).** `scripts/capture-at-fixture.ts` —
  live → fixture trace recorder. Category-rebalance per `J_at_tools.md §5.1`
  (image_qa:8/code_iter:14/research_write:14/mixed:14). 100% manual review (D §3.3).
  Validator gate: `source:'synthetic'` требует `provenance.review_signoff` non-empty.
- **J5. Grader tool-coherence + cache invariance test (1 день).**
  `evaluateToolCalls()` helper в `assistant-traj.ts`. `argsMatch`: `exact`/`subset`/absent;
  `semantic` deferred (J_at_tools.md Q2). Aggregation: `final.primary = content.primary
  × (tool_coherence.pass ? 1.0 : 0.0)` — hard-gate default; revisit в J6 (Q1).
  `score.tool_coherence` всегда populated на AT. `assistant-traj.cache.test.ts` —
  bit-stability tool-result bytes (per inv §10.1).
- **J6. Sweep cutover + AT-v2 baseline refresh (1.5 дня).**
  `eval/sweeps/main_e1_*.yaml` row меняется на n=50; smoke 1 task per baseline (zero
  exit, non-null primary). Per-baseline numbers + diff vs AT-v1 лягут в
  `docs/runs/baselines_frozen.md` (Text benches table с пометкой "AT-v2";
  AT-v1 numbers получают retire note inline). Calibration human_scores.json
  пересчитывается на 5 AT-v2 task'ах. Track D §9 compaction-axis table row
  для AT обновляется (one-line diff).

**Track K — `gaia-med` bench.** Cross-domain agentic bench, пятый
в evaluation-протоколе. Закрывает agentic axis gap (tau узко-доменный
retail; GAIA cross-domain research+web+code+multimodal). Medium scope:
5-tool surface, n=30 stratified subset из Holosophus local snapshot,
skipping xlsx/pdf attachment tasks (effective n ≈ 23-26). Pure-normalization
grader (no LLM-judge — faithful upstream GAIA convention). Wall-clock
~6-7 дней, бюджет $30-50. См. `docs/design/K_gaia.md`.

- **K1. Bench scaffold (1 день).** `scripts/bake-gaia.ts` (Holosophus
  snapshot → `benchmarks/gaia/tasks/gaia_*.json`, filter attachment-tasks);
  `src/eval/adapters/gaia-med.schema.ts` (Zod); `src/eval/adapters/gaia-med.ts`
  (`loadTasks`, `prepare`, `createGaiaGrader` с numeric/list/text
  normalization port из `get_gaia_metrics.py:88-127`). TDD seed: 5 unit
  cases на grader (numeric/list/text/mismatch/missing-Final-prefix).
  References vendored snapshot в `references/gaia/data/` с LICENSE note.
- **K2. Tools port (3 дня).** 5 tools в `src/eval/adapters/gaia-tools/`:
  `web-search.ts` (Tavily API + Brave fallback), `visit-webpage.ts`
  (fetch + readability), `text-editor.ts` (read-only, 100KB cap),
  `python-exec.ts` (`child_process.spawn` + 30s timeout, NOT Docker —
  caveat documented), `describe-image.ts` (vision LLM via OpenRouter).
  Каждый tool — unit test (mocked) + 1 live-gated test. Pre-work: проверить
  `TAVILY_API_KEY` / `BRAVE_API_KEY` в env, иначе ask user before K2 coding.
- **K3. Agent runner + dispatch (1.5 дня).** `runGaiaTask` в
  `src/eval/adapters/gaia-med/agent-runner.ts` — mirror
  `tau-bench-retail/agent-runner.ts` shape с `generateText({tools,
  stopWhen: stepCountIs(20)})`. Bench dispatch в `src/eval/runner.ts`
  для `bench='gaia-med'`. Investigation step 0: support tools у
  `fullContextBaseline` / `mastraOmBaseline` — current `Baseline.step`
  contract возвращает text-only. Решение (per-baseline-tool-passthrough
  vs отдельный runner per-bench) определяется в K3 plan.
- **K4. Sweep + audit (1 день).** `eval/sweeps/{smoke,main_e1}_gaia.yaml`;
  per-level acc + cache rate + per-tool usage distribution + caveats
  (xlsx/pdf skipped, exact-match strictness, python_exec sandbox limitation)
  лягут в `docs/runs/baselines_frozen.md` gaia-med section. Acceptance:
  status=complete на cell, err_rate=0%, ≥30% acc на level-1.

### 7.3 Cut points (milestones)

- **M1 (end day 7)**: `AHC-type-only` работает on LongMemEval-Medium, eval harness готов
  (с Langfuse opt-in), full-context и Anthropic native baselines integrated. **Minimum
  viable** — если что-то пошло не так, можно ужать scope до этой точки.
- **M2 (end day 14)**: AHC-full работает на 3 бенчах (LongMemEval, LoCoMo, τ-bench).
  AssistantTraj в halfway-state. A6 AI SDK v6 adapter complete.
- **M3 (end day 21)**: Full sweep data собран, ablations прогнаны, AssistantTraj готов.
  UI skeleton (G1) работает с full_context baseline. Начинаем отчёт.
- **M4 (end day 28)**: Отчёт готов, UI integrated с AHC (G2 + G3), code в open-able
  состоянии (ещё не packaged, но pre-clean).

Wall-clock с Track G: ~31 день при 2–3 ч/день. Buffer на UI scope creep — drop G3
(telemetry sidebar) если поджимает; minimal UI без sidebar всё ещё считается deliverable.

---

## 8. Принятые решения

Закрытые open questions (зафиксированы Aleksei'ем в discussion):

| Вопрос | Решение |
|---|---|
| Packaging формат | AI SDK v6 совместимый код в монорепо, не отдельный npm пакет на MVP. Packaging — post-MVP. |
| Multimodal judge | GPT-5.4 как LLM-judge для AssistantTraj. Human-verify на 10% sample. |
| VisualWebArena как extra | НЕТ. Скип, остаёмся на AssistantTraj. |
| Reflection layer | ДА, `REFLECTION=true` default. Cache-killer но редкое событие. |
| Mixed-policy reward | Pareto-доминирование на (accuracy × cost). Не multi-objective scalar — Pareto чище для отчёта. |
| LLM provider | OpenRouter всех experiments. Primary actor — Gemini-3.1-Flash; GPT-5.4 secondary только если бюджет. |
| Cache hit measurement | Дополнительный subset (n=10-15) на Anthropic direct API; основные числа — OpenRouter. |
| Tool compaction OOTB | ДА, через `TYPE_AWARE_OFFLOAD=true` default. Отдельный механизм от Observer/Reflector — см. §3.3. |
| Mastra/Anthropic SDK адаптеры | Out of MVP scope. Только AI SDK v6 для v1. |
| Mem0/sliding-window/old configs как baselines | Дроп. Их числа цитируем из существующего paper в Related Work. |

---

## 9. Риски и открытые вопросы

| Риск | Mitigation |
|---|---|
| Mastra OM ≥ AHC на LongMemEval text-only | Позиционируем как cross-class robustness, не как best-on-single-bench |
| Classifier даёт низкую accuracy → hybrid хуже single | Hysteresis + validation на калибровочном set'е; fallback на `mixed` mode |
| AssistantTraj — недостаточно реальных трасс | Synthetic top-up + manual review 100%; fallback размер 30 вместо 40 |
| API costs > бюджета | Урезать N до 60/20/25/30; cheaper actor для secondary runs |
| AI SDK v6 ещё стабилизируется | Закрепить версию в package.json; не использовать experimental APIs |
| Cache hit замер vendor-specific | Документировать как Anthropic-specific; не делать сильных vendor-portable claims |
| Reflection cache invalidation на long traj | Замерить как часто триггерится; если > 1 раз на 15-turn traj — пересмотреть threshold |
| Cost overrun в E1/E2 — runaway $/task | Circuit-breaker в eval harness: если рост cumulative $ за первые 20 задач × 4 = projected > 1.5× budget, halt и revisit. Aggregated cost в telemetry (см. `design/B_eval-harness.md`). |
| AI SDK v6 stable surface ≠ ожидаемому в A6 | Investigation `docs/investigations/ai-sdk-v6-surface.md` перед A6; если ломается — реврайт scope A6, остальные Track A фазы не блокированы (core framework-agnostic). Та же investigation покрывает UI helpers для G1. |
| UI scope creep — Next.js + AHC integration время | Hard 3-day cap на Track G; G3 (sidebar) можно drop'нуть если поджимает — minimal UI без telemetry display всё ещё считается deliverable (см. `design/G_ui.md`) |
| AI SDK v6 UI helpers (`useChat`) unstable | Fallback на manual `fetch` + SSE если useChat broken; решение — investigation prerequisite перед G1 |
| Langfuse docker-compose не поднимается на CI / dev box | `LANGFUSE_ENABLED=false` default; runs работают без observability; warning в logs |

### 9.1 Open questions (требуют решения по ходу)

1. **AssistantTraj eval rubric гранулярность** — насколько детальный rubric для LLM-judge?
   Решение к D4 после первых 10 трасс.
2. **Hysteresis параметр classifier** — 2 turns достаточно или больше? Калибруем на M1.
3. **Schema-aware digest опт-ин или by-default где есть schema?** Решение по результатам
   первых runs.

---

## 10. Validation plan

- **Unit tests**: atomic group detection, scratchpad correctness, cache invariance contract
  (assert prefix bytes equal across calls), pointer roundtrip, classifier features.
- **Smoke tests**: один full eval pipeline на 5 задачах из каждого бенча, ≤ $5 спенда, все
  4 verification checks PASS.
- **Integration tests**: AI SDK v6 middleware end-to-end на toy агенте с custom tools;
  Mastra OM baseline reproducibility (повторный запуск даёт те же числа ± noise).
- **Statistical validation**: paired permutation test, 2-seed replication, bootstrap CI
  для главных дельт.
- **Negative results disclosure**: если AHC проигрывает на каком-то бенче — это идёт в
  Limitations/Discussion с честным анализом причин.

---

## 11. Outputs / Deliverables

Целостный список того, что мы поставляем по итогу проекта. Все артефакты — в репозитории
в open-able состоянии (M4).

### 11.1 Primary deliverables

| Артефакт | Где | Назначение |
|---|---|---|
| **AHC middleware** | `src/core/` + `src/adapters/ai-sdk-v6.ts` | Сама контрибьюция: AI SDK v6 совместимое middleware. Не публикуется на npm (см. §2.2). |
| **AssistantTraj benchmark** | `benchmarks/assistant_traj/` | 30–40 schema-conformant tasks (jay-canvas-seeded + opensource + synthetic) с rubrics. Released как самостоятельный artifact. |
| **Ported benches (D5)** | `src/eval/adapters/{longmemeval,locomo,tau-bench}.ts` + `benchmarks/{longmemeval,locomo,tau-bench}/` | TS BenchAdapter + grader для LongMemEval-med / LoCoMo-med / tau-bench-retail-med, портированные из `references/mle-harness/`. MVP floor — 3 бенча всего (AssistantTraj + 2 из этих 3); полные 4 — stretch. |
| **Eval harness** | `src/eval/` + `eval/sweeps/` | Реусеблый harness с telemetry, statistical pipeline, sweep configs для replication. |
| **Demo UI** | `src/ui/` | Local Next.js app, runnable `npm run dev:ui`. Interactive demo + defense surface. Text + image URL. |
| **Run results** | `benchmarks/runs/` + `figures/` | NDJSON + summary tables + Pareto plots + ablation comparisons. |
| **Course report PDF** | `report/` | Финальный артефакт курса; potentially базис для paper'а. |
| **Reproducibility appendix** | `report/appendix-A.md` | verify.sh + sweep definitions + pinned model versions + seeds + data instructions. |

### 11.2 Observability artifacts

- **Local Langfuse stack** — `docker-compose.yml` запускает self-hosted Langfuse + internal
  pg. AI SDK v6 OpenTelemetry adapter экспортит traces. Opt-in (`LANGFUSE_ENABLED=true`),
  не required для runs. Дизайн — `design/B_eval-harness.md §9`.
- **Per-class breakdown report** — central artifact для Discussion (см. `design/B_eval-harness.md §7`).

### 11.3 Persistence policy (MVP)

| Слой | Хранилище | Restart behavior |
|---|---|---|
| AHC scratchpad | in-memory `Map<sessionId, Scratchpad>` | Gone on process restart; rebuild из history (UI auto-replay) |
| UI conversation state | browser localStorage | Survives browser reload; cross-device — нет |
| Eval harness runs | NDJSON на диск (`benchmarks/runs/`) | Resume-friendly через `--resume` |
| Mastra OM baseline | ephemeral PG via testcontainers | Изолировано в `src/eval/baselines/mastra/`, не пересекается с UI/AHC |

**Нет Postgres / SQLite в основном слое.** Если post-MVP появится need в durable session
restore — добавим `better-sqlite3` (см. `decisions.md` 2026-05-13).

### 11.4 Demo / defense surface

Локальный run:

```bash
docker-compose up langfuse -d   # (опц.) observability backend
npm run dev:ui                   # UI on localhost:3000
```

В UI: chat с моделью через AHC, sidebar показывает class / observations / scratchpad /
recall events в real-time. Это и есть "ассистентская обвязка которой пользуешься"
artifact и основа interactive demo на защите.

### 11.5 Что НЕ deliverable

В дополнение к §2.2:
- Server-side persistence — restart support через browser replay, не через DB.
- Multi-user UI / auth.
- Image upload в UI — только image URL input.
- Production observability dashboards beyond local Langfuse.
- Cross-restart durability scratchpad'а (acceptable: rebuild from history).

### 11.6 Repository layout

Canonical layout. Зафиксирован чтобы track-агенты создавали файлы консистентно
(не плодили анархию). Изменения структуры — отдельный коммит + запись в `decisions.md`.

```
adaptive_hybrid_compaction/
├── README.md, CLAUDE.md                                  # public + operative agent instructions
├── package.json, pnpm-lock.yaml                          # pnpm workspace
├── tsconfig.json, eslint.config.js, vitest.config.ts
├── .gitignore
├── scripts/                                              # verify.sh (A1), per-class-report.ts (B3), plots/ (F2)
├── docs/
│   ├── index.md, system_design.md, decisions.md
│   ├── ai-native-practices.md (historical), agent-pitfalls.md (lazy)
│   ├── design/<X>_<track>.md                             # A_..G_ track-level design
│   ├── implementation/<phase>.md                         # historical (A1, A2, A4); новые не создаём — план фазы живёт в /plan-mode
│   ├── investigations/<topic>.md                         # root-cause analyses (lazy)
│   └── templates/                                        # implementation, investigation
├── src/
│   ├── core/                                             # Track A — framework-agnostic AHC ядро
│   │   ├── types.ts, featureFlags.ts, thresholds.ts      # A1 contracts
│   │   ├── atomicGroup.ts, tiers.ts                      # A1
│   │   ├── offloader.ts, scratchpad.ts, recallTool.ts    # A2
│   │   ├── observer.ts                                   # A3
│   │   ├── classifier.ts                                 # A4
│   │   ├── asyncBuffer.ts, reflection.ts                 # A5
│   │   └── index.ts                                      # explicit named re-exports (no `export *`)
│   ├── adapters/
│   │   └── ai-sdk-v6.ts                                  # A6
│   ├── eval/                                             # Tracks B + C
│   │   ├── types.ts, runner.ts, stats.ts, persistence.ts # B1/B2
│   │   ├── adapters/<bench>.ts                           # bench task loaders — D1-D4: assistant-traj.*; D5: longmemeval, locomo, tau-bench
│   │   └── baselines/                                    # Track C: mastra/, anthropic.ts, fullContext.ts
│   └── ui/                                               # Track G — Next.js App Router
├── eval/
│   └── sweeps/                                           # Track E: main_e1.yaml, ablation_e2.yaml, cache_hit_e3.yaml
├── benchmarks/
│   ├── assistant_traj/                                   # Track D (D1-D4): tasks/, attachments/, rubrics/, judge_cache.json
│   ├── longmemeval/, locomo/, tau-bench/                 # Track D (D5): per-bench tasks/, fixtures portированы из references/mle-harness/
│   └── runs/<bench>/<config_id>/<seed>/                  # Track E: records.ndjson (gitignored) + summary.json + meta.json
├── observability/                                        # B2/§9: docker-compose.yml, langfuse-dashboard.json
├── references/                                           # Vendored upstream snapshot — read-only (см. references/README.md)
└── report/                                               # Track F: финальный PDF + appendix-A.md
```

#### Dependency direction

- `core` не импортит из `adapters` / `eval` / `ui` — **никогда**.
- `adapters` → `core`. `eval` → `core` (через типы). `ui` → `adapters`.
- `references/` никем не импортится в runtime — это port source (B1) и cite source (F4.1).

Нарушения ловятся вручную до первого случая; при первом — поднимаем
`eslint-plugin-boundaries` (см. `CLAUDE.md` Harness Rules).

#### Track ownership

| Директория | Owner |
|---|---|
| `src/core/` | A |
| `src/adapters/` | A6 |
| `src/eval/` (минус `baselines/`) | B |
| `src/eval/baselines/` | C |
| `src/ui/` | G |
| `eval/sweeps/` | E |
| `benchmarks/assistant_traj/` | D |
| `benchmarks/runs/` | E (output) |
| `observability/` | B2 |
| `report/` | F |
| `references/` | one-shot vendored — не правим |
| `scripts/` | shared (track-агент добавляет свой helper в своей фазе) |
| `docs/` | shared (см. `CLAUDE.md` Documentation Routing) |

Не вторгайся в чужой track без явной необходимости. Кросс-track правка → координация
через `decisions.md`.

#### gitignored

- Dependencies: `node_modules/`
- Build: `dist/`, `.next/`, `*.tsbuildinfo`, `.turbo/`, `coverage/`, `.vitest-cache/`
- Eval raw output: `benchmarks/runs/**/*.ndjson` (`summary.json` и `meta.json` коммитятся для воспроизводимости)
- Logs / state: `*.log`, `*.pid`
- Local services: `observability/data/`, `observability/.langfuse/`
- Secrets: `.env`, `.env.local`
- OS-junk: `.DS_Store`
