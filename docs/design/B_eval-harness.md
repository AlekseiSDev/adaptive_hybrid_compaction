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

### Track B (после B3)

**Доступно:**
- `src/eval/` экспортирует run lifecycle (§2): `loadTasks → adapter.prepare →
  runner.execute → grader.score → persist` поверх sweep YAML из `eval/sweeps/`.
- NDJSON persistence в `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson`
  с полной telemetry schema из §3 (`RunRecord`/`TurnRecord` включая
  `cache_read_input_tokens`, `compaction_events`, `recall_events`, `class_signal`).
- Opt-in Langfuse exporter через `LANGFUSE_ENABLED=true` (no-op при `false`,
  нулевой overhead на main sweep'ах).
- Per-class breakdown report (`scripts/per-class-report.ts`) — accuracy split
  по `trajectory_class` на AHC runs.

**Demo (e2e):** `pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke.yaml` —
synthetic 2-task config (1 baseline + 1 ahc_full, 1 seed), пишет
`benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson` и summary.json. Скрипт
+ smoke sweep YAML создаются в B1 как обязательный exit artifact (не оптика —
это "потрогать руками" пайплайн для пользователя/защиты).

**Acceptance gate:** `./scripts/verify.sh` зелёный + `pnpm tsx scripts/eval.ts
--sweep eval/sweeps/smoke.yaml` не падает + NDJSON содержит все required поля
из §3 telemetry schema (включая `cache_read_input_tokens` на Anthropic-routed
turn'ах и non-empty `compaction_events` на ahc_full config'е).

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **B1** | `src/eval/{runner,persist,types}.ts` + `scripts/eval.ts` + `eval/sweeps/smoke.yaml`; smoke run на 1-2 tasks пишет append-safe NDJSON в `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson`; повторный run resume'ится в ту же папку | `pnpm exec vitest run src/eval/persist.test.ts` (NDJSON append + resume по `config_id`) + `pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke.yaml` |
| **B2** | Telemetry fields (`cache_read_input_tokens`, `compaction_events`, `recall_events`, `class_signal`) присутствуют в `TurnRecord`; Langfuse exporter подключается только при `LANGFUSE_ENABLED=true`, иначе no-op | `pnpm exec vitest run src/eval/telemetry.test.ts` (provider tokens authoritative + exporter no-op при `LANGFUSE_ENABLED=false`) + `./scripts/verify.sh test:unit` |
| **B3** | `scripts/per-class-report.ts` — CLI читает NDJSON, агрегирует mode-class per task, печатает accuracy split по `conversational/tool_heavy/mixed` с stderr | `pnpm exec vitest run src/eval/stats.test.ts` (per-class aggregate матчится с mode-class на synthetic NDJSON) + `pnpm tsx scripts/per-class-report.ts benchmarks/runs/<bench>/<config_id>` |

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
| **B2** Token/cache/latency telemetry + Langfuse | B1 | E1, G3 | §3 telemetry schema (full), §9 (all) | `CompactionEvent`, `RecallEvent`, `class_signal`, provider-reported `cache_read_input_tokens` | exporter no-op при `LANGFUSE_ENABLED=false`; provider tokens authoritative (не offline tokenizer) | §6 CostTracker (каркас здесь) |
| **B3** Per-class breakdown | B1, B2 | F2 | §7 (all) | `class_signal` в `TurnRecord` | per-class aggregate матчится с mode-class на synthetic NDJSON; paired permutation по `task_id` | §5 stats pipeline |

**Parallelization:** внутри Track B всё sequential — `B1 → B2 → B3` (B2 расширяет B1 telemetry, B3 consume'ит `class_signal` из B2). Cross-track: B1 разблокирует C1/C2/C3 (baseline interface потребляет `RunRecord`) параллельно с B2.

**Orthogonal / deferred:**
- §5 Statistical pipeline — pure functions поверх NDJSON; реализуется по необходимости (часть B2-tail или E pre-report).
- §6 CostTracker — каркас в B2; реально активируется на E1 (circuit-breaker thresholds).
- §9.6 связь с Track G — фактическая интеграция в G3; здесь только контракт telemetry stream.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: plan-mode
разбивает фазу на task'и, прогресс трекается через TaskCreate / `implementation/<phase>.md`
по `templates/implementation_template.md`. Pseudocode и контракты остаются в design
doc как source of truth, не дублируются в implementation.

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

Cost source: OpenRouter response headers (`usage.cost`); для Anthropic direct API —
calc из billed tokens × price table.

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

```
docker-compose.yml
  langfuse-web   # UI на :3001
  langfuse-pg    # internal storage; не пересекается с runtime AHC / Mastra
```

Запускается отдельной командой: `docker-compose up langfuse -d`. Не required для
`verify.sh` или runs — но рекомендуется во время A2–A6 development и при interactive
debug Track G UI.

### 9.2 Telemetry export

AI SDK v6 имеет встроенный OpenTelemetry support; конфигурируем экспорт к Langfuse
OTLP endpoint:

```typescript
import { LangfuseExporter } from 'langfuse-vercel'   // verify package at B2 start

const tracer = new OpenTelemetryTracer({
  exporters: [new LangfuseExporter({ host: 'http://localhost:3001' })],
})
```

Core AHC дополнительно эмитит custom events через `instrumentation` callback
(см. §3 telemetry schema):
- `compaction_event` (observer / offload / reflection) с before/after bytes
- `classifier_signal` (class, confidence, features snapshot)
- `recall_event` (recall_id, reason)

Эти events попадают в Langfuse как span attributes, видимые в trace view.

### 9.3 Run-time enable / disable

ENV var `LANGFUSE_ENABLED` (default `false`). Если `false` — exporter не подключается,
no-op, нулевой overhead. Это важно для CI runs и для main sweep'ов (E1/E2), где не
хотим side traffic.

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

---

## Open questions

1. Judge cache (для AssistantTraj LLM-judge) — persist на диск или re-run каждый раз?
   Решение — D4 после первых 10 judge runs (зависит от стабильности judge output'a).
2. Concurrent run safety — file locks на NDJSON append'ы или single-writer assumption?
   Default — single-writer; if E1/E2 параллельно → revisit.
