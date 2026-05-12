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
- **Primary actor model**: `google/gemini-3.1-flash` — main experiments, cheap, fast.
- **Secondary actor model**: `openai/gpt-5.4-mini` — если budget и время позволят
  (cross-vendor sanity на small subset).
- **Judge model для LLM-judge eval**: `openai/gpt-5.4` (более capable, но используется
  только для финальной оценки, не в loop).
- **Cheap models для AHC internals** (Observer, digest gen, classifier): дефолтный
  тоже Gemini-3.1-Flash на OpenRouter; в production можно конфигурировать (Mastra-style
  `ModelByInputTokens`).

**Cache hit rate caveat**: OpenRouter не всегда expose cache headers. Cache hit rate как
метрика замеряется на дополнительном small subset (n=10–15) через **direct Anthropic API**
с Sonnet-4.6. Главные accuracy/tokens числа берём с OpenRouter+Gemini.

### 6.2 Бенчмарки

| Бенчмарк | Фильтр | n | Назначение |
|---|---|---|---|
| **LongMemEval-Medium** | `haystack_sessions ≤ 3` | 60 (seed 42) + 30 (seed 43) replication | Conversational long-term memory |
| **LoCoMo-Medium** | Первые 8 sessions каждого диалога | 20 | Conversational temporal |
| **τ-bench retail (medium)** | tasks с optimal path 5–15 actions | 25 | Tool-heavy агентский |
| **AssistantTraj** | новый бенч (см. §6.3) | 30–40 | Multimodal ассистентский |

LongMemEval-Medium и LoCoMo-Medium частично переиспользуют harness из существующего paper.
Размеры n меньше чем в paper (60+30 вместо 120+50) — это NLP-course scope, не paper scope.

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
- **Track G** — Demo UI (требует A6; параллелится с E/F)

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

- **B1. Wire existing harness (1 день).** Portировать существующий из `mle/results/`
  paper'a — что есть переиспользуем, расширения под AHC-specific метрики.

- **B2. Token / cache / latency telemetry + Langfuse observability (2 дня).** Замеры
  `cache_read_input_tokens` (где доступно), wall-clock latency, recall_usage_rate,
  per-class breakdown logging. **Langfuse integration**: `docker-compose.yml` stack +
  AI SDK v6 OpenTelemetry exporter (см. `design/B_eval-harness.md §9`). Opt-in через
  `LANGFUSE_ENABLED=true`; runs работают без Langfuse, если он не поднят.

- **B3. Per-class breakdown reporting (1 день).** Скрипт, который для AHC показывает
  accuracy split по detected trajectory_class — это важно для Discussion в отчёте.

**Track C — Baselines integration**

- **C1. Mastra OM baseline (2 дня).** Поднять Mastra с default config (PG storage,
  observational memory enabled), интегрировать в общий eval harness. Это main competitor.

- **C2. Anthropic native compact wrapper (1 день).** Wrapper над Anthropic Messages API
  с `compact_20260112` strategy, чтобы прогонять в том же harness.

- **C3. Full context baseline (0.5 дня).** Тривиальный wrapper без компакции для upper-bound.

**Track D — Custom benchmark construction**

- **D1. AssistantTraj design + JSON schema (2 дня).** Финализировать категории (8/8/8/14),
  схему задач (input messages, expected outputs, eval rubric), tooling skeleton.

- **D2. Сбор реальных трасс (3 дня).** Aleksei отбирает анонимизированные production
  traces из 2D-canvas, мы их форматируем под schema. Параллельно поиск open-source
  benches.

- **D3. Synthetic top-up + manual review (3 дня).** Если real + open-source < 30 трасс
  — догенерация через Sonnet с разнообразными prompts; 100% manual review каждой трассы
  (5–10 мин на трассу).

- **D4. Eval adapter + LLM-judge rubrics (2 дня).** Adapter для AssistantTraj в общий
  harness, написать judge prompts для каждой категории, calibration sample (10% human-verify).

**Track E — Main runs**

- **E1. Sweep всех 4 baselines × 4 бенчей (3 дня wall-clock).** На OpenRouter+Gemini-3.1-Flash,
  с replication seed. Бюджет ~$80–120 (грубо: 4×4×~80 задач × $0.05/задача).

- **E2. Ablation grid (4 configs × 2 benches) (1 день).** AHC variants на ключевых
  бенчах. ~$30.

- **E3. Cache hit rate subset (0.5 дня).** n=10-15 через Anthropic direct API, Sonnet-4.6.
  ~$20.

**Track F — Course report**

- **F1. Структура отчёта по NLP_Course_Template (2 дня).** Заполнить секции (Intro,
  Related Work, Model Description с references на design/A_ahc-algorithm.md, Dataset, Experiments,
  Results, Conclusion). Главная Results таблица.

- **F2. Figures + discussion (2 дня).** Pareto plot per benchmark, per-class breakdown bar
  chart, ablation comparison. Discussion section с честным анализом negative results если есть.

- **F3. Финальный pass + полировка (1 день).** Корректура, refs.bib, проверка терминологии,
  reproducibility appendix.

**Track G — Demo UI**

- **G1. Skeleton + AI SDK v6 chat (1 день).** Next.js App Router app в `src/ui/`.
  `useChat` hook на OpenRouter provider, text + image URL input, multi-turn без AHC.
  AI SDK v6 UI helpers — часть `ai-sdk-v6-surface` investigation (A6 prerequisite).
  Exit: chat работает end-to-end через UI.

- **G2. AHC integration (1 день).** Mount AHC middleware в `/api/chat` route. Per-session
  scratchpad lifecycle (in-memory `Map<sessionId, Scratchpad>`, TTL 1ч idle). Feature flags
  читаются из query params для quick toggling. Exit: AHC active в demo runs, recall работает.

- **G3. Telemetry sidebar (1 день).** Backend injects AHC stats в response envelope;
  frontend sidebar показывает live class, observations, scratchpad size, recall events,
  current flags. Consume'ит тот же telemetry поток, что Langfuse (Track B). Exit: видно
  как AHC компактит во время real conversation.

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
| **AssistantTraj benchmark** | `benchmarks/assistant_traj/` | 30–40 anonymized real + opensource + synthetic tasks с rubrics. Released как самостоятельный artifact. |
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
