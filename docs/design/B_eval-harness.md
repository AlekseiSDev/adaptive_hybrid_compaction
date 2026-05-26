# Track B Design — Eval Harness

> Track-level design расширения eval harness, на котором гоняются AHC и baselines
> на 4 бенчмарках. Реализуется в `src/eval/`. Source of truth для telemetry schema,
> run persistence, statistical pipeline. Phase plan — `system_design §7.2 Track B`.

---

## Meta

- **Track:** B (B1 wire existing → B2 telemetry → B3 per-class breakdown)
- **Wall-clock:** 4 дня
- **Зависит от:** vendored snapshot upstream harness'а в `references/mle-harness/code/` (B1 — port в `src/eval/`)
- **Блокирует:** Track E (main runs)
- **Связь:** `system_design §6` (metrics + benchmarks), `design/C_baselines.md`
  (baseline integration), `design/D_assistant-traj.md` (AssistantTraj adapter)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе.

### Track B (после B4)

**Доступно:**
- `src/eval/` экспортирует run lifecycle (§2): `loadTasks → adapter.prepare →
  runner.execute → grader.score → persist` поверх sweep YAML из `eval/sweeps/`.
- NDJSON persistence в `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson`
  с полной telemetry schema из §3 (`RunRecord`/`TurnRecord` включая
  `cache_read_input_tokens`, `compaction_events`, `recall_events`, `class_signal`).
- `Baseline` interface (см. `design/C_baselines.md §1`) + `buildRunnerFromBaseline`
  helper (`src/eval/baseline.ts`) — мост между per-turn baselines и outer
  `Runner` interface (B1).
- `LLMClient` (`src/eval/llm.ts`) — raw fetch wrapper над OpenRouter
  `/api/v1/chat/completions`; provider-neutral request/response shape; OpenAI-
  compatible. Anthropic direct API — отдельный wrapper при E3 cache subset.
- `full_context` baseline (`src/eval/baselines/full_context.ts`) — ships в B2
  как vertical-slice deliverable (de-facto Track C C3); pass-through history
  через OpenRouter, `Baseline` impl.
- `CostTracker` активен в `runSweep` (§6): observe + shouldHalt по 1.5× projected
  budget после 20 tasks. Halt = clean break + NDJSON state preserved (resumable).
- Full OpenTelemetry pipeline (sdk-trace-node + `@langfuse/otel`'s
  `LangfuseSpanProcessor`) — sweep / config-seed / task / turn spans всегда
  создаются; exporter подключается только при `LANGFUSE_ENABLED=true` (no-op
  через NoopTracerProvider иначе, нулевой overhead на main sweep'ах).
- Per-class breakdown report (`scripts/per-class-report.ts`) — accuracy split
  по `trajectory_class` на AHC runs.
- **Zero-touch Langfuse bootstrap**: `observability/docker-compose.yml` использует
  `LANGFUSE_INIT_*` env vars (org/project/admin user/API keys pre-created на
  первом старте контейнера) — no UI walk требуется (см. §9.1). `.env.example`
  fixирует deterministic `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` literals
  для local dev; production / shared deployments — отдельные значения через
  `.env.local`.
- **End-to-end Langfuse trace verifier** (`scripts/check-langfuse-hierarchy.ts`,
  rename из B4 `check-langfuse-trace.ts`): CLI fetch'ит Langfuse REST API
  `/api/public/traces|sessions|observations` с public/secret key + filter
  по timestamp. Default `--mode=hierarchy` asserts session/trace/span tree
  (B6); legacy `--mode=count` для B4 acceptance gate. Programmatic
  acceptance вместо visual UI walk.

**Demo (e2e):** Три smoke-режима:
- Stub-only (B1 regression, no API key): `pnpm tsx scripts/eval.ts --sweep
  eval/sweeps/smoke.yaml` — synthetic 2-task config (`noop_baseline` + `noop_ahc`,
  1 seed), пишет `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson` и
  summary.json. Создан в B1.
- Vertical slice — code path (B2, manual gate, нужен `OPENROUTER_API_KEY`):
  `OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts --sweep
  eval/sweeps/smoke_full_context.yaml` — synthetic + `full_context` baseline →
  real Gemini-3.1-Flash через OpenRouter; NDJSON содержит provider-reported
  tokens.
- End-to-end с Langfuse (B4, manual gate, нужен Langfuse stack + keys):
  `docker compose -f observability/docker-compose.yml up -d` →
  `LANGFUSE_ENABLED=true OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts
  --sweep eval/sweeps/smoke_full_context.yaml` →
  `pnpm tsx scripts/check-langfuse-hierarchy.ts --mode=count --since-seconds=60`
  (REST API verifier — exit 0 если ≥ 1 trace доехал в Langfuse за последние
  60 сек).
  Артефакты от real run в git **не** попадают (per `decisions.md 2026-05-13`
  B4 entries) — это validation step, не reproducibility evidence.

**Acceptance gate:** `./scripts/verify.sh` зелёный + stub-only smoke не падает
+ vertical-slice smoke (с key) не падает + NDJSON содержит все required поля
из §3 telemetry schema + B4 end-to-end Langfuse trace verifier exit 0 (когда
Langfuse stack поднят). `cache_read_input_tokens` non-empty появляется на E3
Anthropic-direct subset, не на main OpenRouter sweep'ах; non-empty
`compaction_events` появятся когда AHC integration (через `createAhcMiddleware`
из A6 или ahc_core runner) станет default на ahc config'е.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **B1** | `src/eval/{runner,persist,types}.ts` + `scripts/eval.ts` + `eval/sweeps/smoke.yaml`; smoke run на 1-2 tasks пишет append-safe NDJSON в `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson`; повторный run resume'ится в ту же папку | `pnpm exec vitest run src/eval/persist.test.ts` (NDJSON append + resume по `config_id`) + `pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke.yaml` |
| **B2** | Telemetry fields (`cache_read_input_tokens`, `compaction_events`, `recall_events`, `class_signal`) присутствуют в `TurnRecord`; `LLMClient` + OpenRouter wire; `Baseline` interface + `buildRunnerFromBaseline`; `full_context` baseline ships (de-facto C3); CostTracker активен в `runSweep`; OTel pipeline через `@langfuse/otel` `LangfuseSpanProcessor`, exporter no-op при `LANGFUSE_ENABLED=false` | `pnpm exec vitest run src/eval/telemetry.test.ts` (provider tokens authoritative) + `pnpm exec vitest run src/eval/observability/langfuse.test.ts` (exporter no-op при `LANGFUSE_ENABLED=false`) + manual: `OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_full_context.yaml` |
| **B3** | `scripts/per-class-report.ts` — CLI читает NDJSON, агрегирует mode-class per task, печатает accuracy split по `conversational/tool_heavy/mixed` с stderr | `pnpm exec vitest run src/eval/stats.test.ts` (per-class aggregate матчится с mode-class на synthetic NDJSON) + `pnpm tsx scripts/per-class-report.ts benchmarks/runs/<bench>/<config_id>` |
| **B4** | `observability/docker-compose.yml` zero-touch boots Langfuse v3 (`LANGFUSE_INIT_*` env vars pre-create org/project/admin user/API keys); `scripts/check-langfuse-hierarchy.ts --mode=count` (CLI REST verifier, renamed from `check-langfuse-trace.ts` in B6); vertical-slice smoke с `LANGFUSE_ENABLED=true` доставляет ≥ 1 trace в Langfuse | `docker compose -f observability/docker-compose.yml up -d` (wait healthchecks) + `LANGFUSE_ENABLED=true OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_full_context.yaml` + `pnpm tsx scripts/check-langfuse-hierarchy.ts --mode=count --since-seconds=60` (exit 0) |
| **B5** | `src/eval/runners/ahc_core.ts` — real AHC runner: `wrapLanguageModel({model, createAhcMiddleware(...)})` поверх `@ai-sdk/openai` configured for OpenRouter; `generateText({experimental_telemetry:{isEnabled,functionId:'ahc.step'}})` → AI SDK auto-spans под `eval.task`; cost-aware LLMCaller wrapper (digest/observer/reflection LLM calls accrue в `step.cost_usd`). Per-task `eval.task` span с `langfuse.observation.input/output` для **всех** configs (landed Commit A). `noop_ahc` остаётся как explicit offline baseline (`baseline: noop_ahc` в YAML). `eval/sweeps/smoke_ahc_core.yaml` для smoke. | `pnpm exec vitest run src/eval/runners/ahc_core.test.ts` (factory shape + cost-aware wrapper + event-mapper) + (с `OPENROUTER_API_KEY`) `pnpm exec vitest run src/eval/runners/ahc_core.live.test.ts` (3-turn pin-recall через real OpenRouter + AHC pipeline) + `LANGFUSE_ENABLED=true OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_ahc_core.yaml` → Langfuse UI показывает `eval.sweep > eval.task > ai.generateText > ai.generateText.doGenerate` |
| **B6** | `eval.task` стартует с `ROOT_CONTEXT` (root trace, parent link к `eval.sweep` разорван) + attribute `langfuse.session.id = ${bench}-${config_id}-${seed}`; `eval.turn` span per `baseline.step()` обёртка в `src/eval/baseline.ts` (multi-turn benches) и в `src/eval/adapters/tau-bench-retail/agent-runner.ts` (custom episode loop); `scripts/check-langfuse-hierarchy.ts` (rename из `check-langfuse-trace.ts`) — REST verifier fetch'ит `/api/public/sessions|traces|observations`, assert'ит nested tree (eval.task → eval.turn × N → ai.generateText → ai.toolCall × M); 3 smoke sweep'а `eval/sweeps/smoke_hierarchy_{gaia,lme_mt,at}.yaml` (n=3 each). | `pnpm exec vitest run src/eval/runner.test.ts` (eval.task `parentSpanId === undefined` + session.id attr) + `pnpm exec vitest run src/eval/baseline.test.ts` (3 `eval.turn` spans для 3-message conv) + manual: `LANGFUSE_ENABLED=true OPENROUTER_API_KEY=... pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_hierarchy_gaia.yaml` + `pnpm tsx scripts/check-langfuse-hierarchy.ts --bench=gaia-med --since-seconds=300 --expected-turns-min=1 --expected-tool-calls-min=1` exit 0 |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track B`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы из §3, которые трогает или вводит фаза.
- **TDD seed** — failing test, с которого фаза стартует (Red в TDD-цикле).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты (§3) | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **B1** Wire existing harness | — | B2, B3, C1/C2/C3, E1 | §2 run lifecycle, §4 persistence, §8 sweep YAML | `RunRecord`, `TurnRecord`, `Score`, `TokenUsage`, `ErrorRecord` | NDJSON append-safety + resume по `config_id` (повторный run пишет в ту же папку) | §1 scope |
| **B2** Token/cache/latency telemetry + Langfuse + ships `full_context` (C3) | B1 | C1, C2, E1, G3 | §2 run lifecycle (LLMClient wire), §3 telemetry schema (full), §6 (CostTracker active), §9 (all) | `CompactionEvent`, `RecallEvent`, `class_signal`, provider-reported `cache_read_input_tokens`; `Baseline` interface + `buildRunnerFromBaseline` helper | exporter no-op при `LANGFUSE_ENABLED=false`; provider tokens authoritative (не offline tokenizer); CostTracker `shouldHalt` projection halts при > 1.5× budget после 20 tasks | §6 CostTracker (активный); `design/C_baselines.md §1` (Baseline contract) |
| **B3** Per-class breakdown | B1, B2 | F2 | §7 (all) | `class_signal` в `TurnRecord` | per-class aggregate матчится с mode-class на synthetic NDJSON; paired permutation по `task_id` | §5 stats pipeline |
| **B4** End-to-end Langfuse vertical-slice verification | B2 | E1 (real-LLM main sweep), F1 (Methods reproducibility appendix) | §9 (full Langfuse stack), §9.1 (`docker-compose.yml` headless init) | (no new schema — verifies §9.2 export pipeline end-to-end) | smoke с `LANGFUSE_ENABLED=true` → trace доезжает в Langfuse REST API (`/api/public/traces?fromTimestamp=...`) ≥ 1 за 60 сек | §9.5 failure modes (Langfuse down handled gracefully); `decisions.md 2026-05-13` B4 entries |
| **B5** AHC runtime integration | A6 (middleware), B4 (Langfuse stack) | E1 (AHC vs baselines sweep) | §2 run lifecycle, §3 telemetry schema (`compaction_events`, `recall_events`, `class_signal` теперь non-empty для ahc_core), §9 (per-task + ai.* auto-spans) | `Baseline` (`prepare/step`), `InstrumentationEvent` (`mapCoreEventToInstrumentation`), `CompactionEvent.llm_cost_usd` теперь populates через cost-aware caller | (Red) `ahcCoreBaseline(...).prepare(task)` returns scratch-bound state + factory creates wrapped LanguageModelV3 + cost-aware wrapper accumulates на 2 calls = expected pricing math + event mapper `classifier_signal → class_signal` rename | §6 cost-aware caller meaningful только для AHC (baselines одно-LLM-call-per-turn); A6 middleware `transformParams` passthrough при отсутствии system msg — synthetic adapter в B5 prepends system |
| **B6** Langfuse session/trace/span hierarchy | B5 (auto-spans), B4 (Langfuse stack), J/K (tool-using benches для tool-call span verify) | F2 (per-class plots могут drill down через session UI), debug workflows | §9.2 (trace structure: `eval.task` root + session.id), §9.7 (verifier extended) | (no new persistence schema — pure OTel attribute + parent-link change); attribute `langfuse.session.id` literal | (Red) `runSweep` на synthetic 2-task config → in-memory exporter ловит `eval.task` spans с `parentSpanId === undefined` + `langfuse.session.id === 'synthetic-<config_id>-<seed>'`; `buildRunnerFromBaseline` на 3-message conv → 3 `eval.turn` spans с `turn.index ∈ {0,1,2}` всё parent = `eval.task` | §3 `InstrumentationEvent` NOT touched (tool calls идут через AI SDK auto-spans, не custom event); `decisions.md 2026-05-26` B6 entries |

**Parallelization:** внутри Track B всё sequential — `B1 → B2 → B3 → B4 → B5 → B6` (B2 расширяет B1 telemetry, B3 consume'ит `class_signal` из B2, B4 verifies §9 end-to-end, B5 нуждается в A6 + B4 Langfuse stack для validation, B6 расширяет B5 spans иерархией). Cross-track: B1 разблокирует C1/C2/C3 (baseline interface потребляет `RunRecord`) параллельно с B2; B5 разблокирует E1 (real AHC vs baselines numbers); B6 не блокирует E1 (instrumentation purely additive — main sweep'ы работают без observability).

**Orthogonal / deferred:**
- §5 Statistical pipeline — pure functions поверх NDJSON; реализуется по необходимости (часть B2-tail или E pre-report).
- §6 CostTracker — реализован и **активирован в `runSweep` уже в B2**; circuit-breaker thresholds (1.5× projected) применяются по умолчанию. E1 может калибровать `budget_usd` в sweep YAML.
- §9.6 связь с Track G — фактическая интеграция в G3; здесь только контракт telemetry stream.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Scope

- **In**:
  - Общая run lifecycle (task → adapter → model → response → grader → result row)
  - Telemetry schema (single source of truth для всех runs)
  - Persistence layout на диске
  - Statistical analysis pipeline (paired permutation, bootstrap CI, per-class breakdown)
  - Cost tracking + circuit-breaker
  - Configuration matrix / sweep definitions
- **Out**:
  - Bench-specific task loading (живёт в `src/eval/adapters/<bench>.ts`)
  - Baseline implementations (см. `design/C_baselines.md`)
  - AssistantTraj task construction (см. `design/D_assistant-traj.md`)

---

## 2. Run lifecycle

```
loadTasks(bench, seed) ──> List<Task>
  └── for each Task:
      ├── adapter.prepare(task) → Conversation
      ├── runner.execute(conv, config) → Response[] + TurnRecord[]
      ├── grader.score(task, response) → Score
      ├── telemetry.aggregate(turnRecords, score, cost) → RunRecord
      └── persist(RunRecord) → NDJSON line
```

`config` — комбинация `(model, ahc-flags, baseline-wrapper, seed)`. `config_id` —
deterministic hash из сериализованного config; используется в persistence layout.

---

## 3. Telemetry schema

В `src/eval/types.ts`. `core` не зависит от этих типов — отдаёт neutral
`CompactionEvent`-производные через `instrumentation` callback, harness aggregate'ит.

```typescript
type RunRecord = {
  run_id: string                  // ulid
  bench: 'longmemeval-med' | 'locomo-med' | 'tau-bench-retail-med' | 'assistant-traj'
  config_id: string
  seed: number
  task_id: string
  started_at: number              // ms epoch
  completed_at: number
  score: Score
  totals: TokenUsage
  cost_usd: number
  turns: TurnRecord[]
  errors: ErrorRecord[]
}

type TurnRecord = {
  turn_index: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number    // Anthropic-specific
  cache_creation_input_tokens?: number
  wall_clock_ms: number
  ttfb_ms?: number
  class_signal?: { class: TrajectoryClass; confidence: number }   // AHC-only
  recall_events: RecallEvent[]
  compaction_events: CompactionEvent[]
}

type RecallEvent = {
  recall_id: string
  tool_name: string
  reason: string                  // user-supplied at recall time
  turn_index: number
}

type CompactionEvent = {
  type: 'observer' | 'offload' | 'reflection'
  turn_index: number
  before_bytes: number
  after_bytes: number
  llm_cost_usd?: number           // если compaction вызывает LLM (Observer / Reflector)
}

type Score = {
  primary: number                 // bench-specific accuracy / pass@1
  secondary?: Record<string, number>
  judge_explanation?: string      // LLM-judge cases (AssistantTraj)
}

type TokenUsage = {
  input: number
  output: number
  cache_read?: number
  cache_creation?: number
}

type ErrorRecord = {
  turn_index: number
  kind: 'api_error' | 'tool_error' | 'judge_error' | 'timeout'
  message: string
}
```

**Token usage source**: provider response headers (OpenRouter `usage.{prompt_tokens,
completion_tokens}` для main actor Gemini-3.1-Flash; Anthropic direct `usage.{input_tokens,
output_tokens,cache_read_input_tokens}` для cache-hit subset E3). Не используем offline
tokenizer (`@anthropic-ai/tokenizer` или аналоги) — для не-Anthropic моделей они дают
wrong numbers. NDJSON хранит provider-reported counts как authoritative; Langfuse (см. §9)
consume'ит тот же event stream через OpenTelemetry adapter, не считает токены сам.

---

## 4. Persistence

```
benchmarks/runs/
  <bench>/
    <config_id>/
      <seed>/
        records.ndjson      # один RunRecord на строку, append-safe
        summary.json        # derived aggregate (recomputable)
        meta.json           # config snapshot + git_sha + timestamp
```

NDJSON выбран, чтобы append'ить безопасно во время run и parse'ить post-hoc tooling'ом
без load-all-in-memory. `config_id` стабилен (deterministic hash), повторный run тех же
params пишет в ту же папку → replication явный, resume тривиальный (см. `design/E_main-runs.md §6`).

---

## 5. Statistical pipeline

`src/eval/stats.ts`. Entry points:

- `pairedPermutation(records_a, records_b, metric, n_perm=10_000) → { delta, p_value }`
- `bootstrapCI(records, metric, n_boot=2000, alpha=0.05) → { lower, upper, mean }`
- `perClassBreakdown(records, classExtractor) → Map<class, Stats>`

Соглашения:
- Парные тесты — paired по `task_id`, не по subjects. Если в одной из групп task
  отсутствует — drop из обоих.
- Replication: mean ± stderr across 2 seeds. Statsig — p < 0.05 на главных дельтах
  (см. `system_design §2.3`).
- Все статистические скрипты — pure functions над NDJSON; никакого live API call'а.

---

## 6. Cost tracking + circuit-breaker

**Status:** Активирован в `runSweep` начиная с B2 (см. `decisions.md 2026-05-13` B2 entries).
Не каркас — `observe` дёргается после каждого `appendRecord`, `shouldHalt` проверяется
перед следующим task'ом, halt = clean break + NDJSON state preserved (resumable next run).

```typescript
class CostTracker {
  private cumulative_usd = 0
  private task_count = 0

  observe(record: RunRecord) {
    this.cumulative_usd += record.cost_usd
    this.task_count += 1
  }

  shouldHalt(plan: SweepPlan): { halt: boolean; reason?: string } {
    if (this.task_count < 20) return { halt: false }
    const projected = (this.cumulative_usd / this.task_count) * plan.total_tasks
    if (projected > 1.5 * plan.budget_usd) {
      return { halt: true, reason: `projected ${projected.toFixed(2)} > 1.5× budget` }
    }
    return { halt: false }
  }
}
```

Triggers (см. `system_design §9`):
- Projected cost > 1.5× budget после первых 20 задач → halt + warn user.
- Per-task cost > 5× median expected → log warning, не halt (один мультимодальный
  payload может выпасть).

`plan.total_tasks` — `computeTotalTasks(plan, adapters)` helper loop'ится по benches и
суммирует `(await adapter.loadTasks(seed)).length × seeds.length × configs.length`.
Кэшируем результат внутри `runSweep` invocation.

Cost source: OpenRouter `/api/v1/chat/completions` response **не возвращает `usage.cost`**;
считаем offline через `OPENROUTER_PRICING` snapshot const в `src/eval/llm.ts` —
`cost = (prompt_tokens × input_per_million + completion_tokens × output_per_million) / 1e6`.
Pricing snapshot — manual maintenance, fresh за commit; альтернатива (deferred) — API call
к OpenRouter `/models` endpoint в startup, cache в `meta.json`. Для Anthropic direct API —
calc из billed tokens × price table (E3-only path).

---

## 7. Per-class breakdown (B3)

Для AHC runs скрипт `scripts/per-class-report.ts`:
1. Extract `class_signal` из каждого `TurnRecord`.
2. Aggregate на task-level (mode-class за task).
3. Считать accuracy split:

```
class_distribution_for_AHC:
  conversational:  N tasks, accuracy = A1 ± stderr
  tool_heavy:      N tasks, accuracy = A2 ± stderr
  mixed:           N tasks, accuracy = A3 ± stderr
```

Эта breakdown — central artifact для Discussion в отчёте: показывает что classifier
работает осмысленно и AHC не паразитирует на per-class wins.

---

## 8. Configuration matrix

Sweep definitions — `eval/sweeps/<name>.yaml`:

```yaml
name: main_e1
benches: [longmemeval-med, locomo-med, tau-bench-retail-med, assistant-traj]
configs:
  - id: full_context
    baseline: full_context
  - id: anthropic_native
    baseline: anthropic_compact
  - id: mastra_om
    baseline: mastra
  - id: ahc_full
    ahc_flags: { ... defaults from system_design §5.1 ... }
seeds: [42, 43]
budget_usd: 120
```

Главные sweep'ы:
- `main_e1` — 4 baselines × 4 benches × 2 seeds (E1)
- `ablation_e2` — 4 AHC configs × 2 benches × 2 seeds (E2)
- `cache_hit_e3` — Anthropic direct API subset, 10–15 tasks (E3)

Детали orchestration — `design/E_main-runs.md`.

---

## 9. Observability — Langfuse integration

Цель: real-time inspection AHC во время development и eval runs. Self-hosted Langfuse,
opt-in (runs работают без observability, если она не поднята). Встроено в Track B
как часть B2, не отдельный трек.

### 9.1 Stack

Langfuse v3 self-hosted (6 services per upstream compose template):

```
observability/docker-compose.yml
  langfuse-web      # UI на :3001 + REST API
  langfuse-worker   # async event processing
  postgres:17       # auth/users/projects metadata
  clickhouse:24.12  # trace storage
  redis:7           # queue / pubsub
  minio             # S3-compatible blob storage для events
```

Запускается отдельной командой: `docker compose -f observability/docker-compose.yml
up -d`. Не required для `verify.sh` или main sweep'ов — но **обязательно** для
B4 acceptance gate (end-to-end Langfuse trace verifier).

**Headless bootstrap (B4):** `langfuse-web` env содержит `LANGFUSE_INIT_*` блок:

```yaml
LANGFUSE_INIT_ORG_ID: ahc-dev
LANGFUSE_INIT_ORG_NAME: AHC Dev
LANGFUSE_INIT_PROJECT_ID: ahc
LANGFUSE_INIT_PROJECT_NAME: AHC eval
LANGFUSE_INIT_PROJECT_PUBLIC_KEY: pk-lf-ahc-dev-deterministic
LANGFUSE_INIT_PROJECT_SECRET_KEY: sk-lf-ahc-dev-deterministic
LANGFUSE_INIT_USER_EMAIL: dev@ahc.local
LANGFUSE_INIT_USER_NAME: AHC Dev
LANGFUSE_INIT_USER_PASSWORD: ahc-dev-CHANGEME
```

Org/project/admin user/API keys создаются на первом старте container'а (idempotent
на subsequent restarts). `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` для SDK
читаются из тех же deterministic значений в `.env.example` (committed) — local dev
не требует UI walk. Production / shared deployments — другие keys через `.env.local`
(gitignored).

### 9.2 Telemetry export

**Package choice (finalized B2):** `@langfuse/otel@^5.3.0` (v5 SDK rewrite — supersedes
deprecated `langfuse-vercel@3.x`; см. `decisions.md 2026-05-13` B2 entries). Минимальный
OTel-стек:

```typescript
// src/eval/observability/langfuse.ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'

const provider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3001',
    }),
  ],
})
provider.register()
```

Зависимости: `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`,
`@opentelemetry/resources`, `@opentelemetry/semantic-conventions`,
`@opentelemetry/exporter-trace-otlp-http` (peer dep of `@langfuse/otel`).

`scripts/eval.ts` оборачивает `runSweep` в `setupObservability()` → spans
`eval.sweep` / `eval.task` / `eval.turn` создаются всегда; LangfuseSpanProcessor
attach'ится только при `LANGFUSE_ENABLED=true`. (`eval.config_seed` уровень
дизайн-документировался но не приземлился — между sweep и task не оказалось
естественного границ; session идентификатор делает группировку через атрибут,
а не через span.)

**Trace boundary alignment** (B6, см. `decisions.md 2026-05-26` B6 entries):
- `eval.sweep` — standalone trace с aggregate sweep metadata (`sweep.name`,
  `sweep.total_cost_usd`, `sweep.halted`, …). НЕ parent для tasks.
- `eval.task` — root trace для одного sample; стартует с `ROOT_CONTEXT`.
  Attribute `langfuse.session.id = ${bench}-${config_id}-${seed}` — Langfuse
  группирует traces одной ячейки sweep'а под одну session.
- `eval.turn` — child от `eval.task`; per `baseline.step()` (multi-turn benches:
  `lme-multiturn`, `tau-bench-retail-med`, `assistant-traj`). Attribute
  `turn.index` идентифицирует позицию.
- `ai.generateText.*`, `ai.toolCall` — auto-emitted AI SDK spans под
  соответствующий `eval.turn` (или прямо под `eval.task` для single-shot
  benches типа `gaia-med`). OTel context propagation обрабатывает nesting
  автоматически — custom `ToolCallEvent` инструментация **не вводится**.

Core AHC дополнительно эмитит custom events через `instrumentation` callback
(см. §3 telemetry schema):
- `compaction_event` (observer / offload / reflection) с before/after bytes
- `classifier_signal` (class, confidence, features snapshot)
- `recall_event` (recall_id, reason)

Эти events попадают в Langfuse как span attributes, видимые в trace view.

### 9.3 Run-time enable / disable

ENV vars (per `@langfuse/otel` v5 API):
- `LANGFUSE_ENABLED` (default `false`) — master switch
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` — required when enabled
- `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`; для self-hosted —
  `http://localhost:3001`)

Если `LANGFUSE_ENABLED=false` — `LangfuseSpanProcessor` не attach'ится,
`NodeTracerProvider` не register'ится (NoopTracerProvider остаётся global default).
Нулевой overhead. Это важно для CI runs и для main sweep'ов (E1/E2), где не хотим
side traffic.

### 9.4 Dashboard config

Pre-built dashboard конфиг в `observability/langfuse-dashboard.json` (export via
Langfuse UI после initial setup). Tracks:
- Token usage per turn (input / output / cache_read)
- Compaction event frequency
- Classifier class distribution over time
- Recall tool usage rate

### 9.5 Failure modes

| Failure | Mitigation |
|---|---|
| Langfuse недоступен (down / network) | Exporter timeouts, НЕ блокирует run. Logged as warning. |
| Очень большой trace (long traj) | Sampling: 100% для dev, 10% для production runs |
| Schema mismatch (Langfuse upgrade) | Pin docker image tag; upgrade — separate investigation |

### 9.6 Связь с Track G

Track G UI consume'ит ту же telemetry, что и eval harness — единый поток событий из
`core/`. UI отображает их inline (sidebar); Langfuse — для post-hoc analysis. Один
источник, два consumer'а.

### 9.7 End-to-end verification (B4 + B6)

`scripts/check-langfuse-hierarchy.ts` (rename из B4 `check-langfuse-trace.ts`) —
programmatic acceptance gate, заменяет visual UI walk. Два режима:

**`--mode=count` (B4 fallback, legacy):**

```bash
pnpm tsx scripts/check-langfuse-hierarchy.ts --mode=count \
  --since-seconds=60 [--min-traces=1]
```

1. Читает `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` из env.
2. `fetch GET ${baseUrl}/api/public/traces?fromTimestamp=<now - since_seconds>` с
   HTTP Basic auth (`publicKey:secretKey`).
3. Печатает `trace_id`, `name`, `observation_count` для каждого trace.
4. Exit 0 если `data.length >= min-traces`; exit 1 иначе.

**`--mode=hierarchy` (B6 default):**

```bash
pnpm tsx scripts/check-langfuse-hierarchy.ts --mode=hierarchy \
  --bench=gaia-med --since-seconds=300 \
  [--config-id=<id>] [--seed=42] \
  [--expected-turns-min=N] [--expected-tool-calls-min=M]
```

1. Fetch `/api/public/sessions?fromTimestamp=...` — фильтр session_id по prefix
   `${bench}-` (или явный `${bench}-${config_id}-${seed}` если указаны).
2. Для matched session — `/api/public/sessions/<id>` → список traces.
3. Для каждого trace — `/api/public/traces/<id>` → observations tree.
4. Assertions:
   - Trace name = `eval.task`, `parent_observation_id === null` (root).
   - Child observations включают ≥ `--expected-turns-min` spans с name=`eval.turn`.
   - Child observations включают ≥ `--expected-tool-calls-min` spans с
     name начинающимся с `ai.toolCall`.
5. Печатает tree-view (indented) + summary. Exit 0 если все asserts pass.

Acceptance gates:
- **B4** (legacy): после `LANGFUSE_ENABLED=true ... pnpm tsx scripts/eval.ts
  --sweep eval/sweeps/smoke_full_context.yaml` (vertical-slice smoke) →
  `check-langfuse-hierarchy.ts --mode=count` exit 0.
- **B6**: после `LANGFUSE_ENABLED=true ... pnpm tsx scripts/eval.ts --sweep
  eval/sweeps/smoke_hierarchy_<bench>.yaml` (n=3 each) →
  `check-langfuse-hierarchy.ts --mode=hierarchy --bench=<bench>
  --expected-turns-min=<bench-specific>` exit 0 для всех 3 benches
  (`gaia-med`, `lme-multiturn`, `assistant-traj`).

Real-run артефакты (NDJSON / summary / meta) от B4/B6 verification **не**
коммитятся в git — это validation step, а не reproducibility evidence. См.
`decisions.md 2026-05-13` B4 entries + `decisions.md 2026-05-26` B6 entries.

---

## Open questions

1. Judge cache (для AssistantTraj LLM-judge) — persist на диск или re-run каждый раз?
   Решение — D4 после первых 10 judge runs (зависит от стабильности judge output'a).
2. Concurrent run safety — file locks на NDJSON append'ы или single-writer assumption?
   Default — single-writer; if E1/E2 параллельно → revisit.
