# Track B Design — Eval Harness

> Track-level design расширения eval harness, на котором гоняются AHC и baselines
> на 4 бенчмарках. Реализуется в `src/eval/`. Source of truth для telemetry schema,
> run persistence, statistical pipeline. Phase plan — `system_design §7.2 Track B`.

---

## Meta

- **Track:** B (B1 wire existing → B2 telemetry → B3 per-class breakdown)
- **Wall-clock:** 4 дня
- **Зависит от:** существующий harness в `mle/results/` paper'a (B1 — port)
- **Блокирует:** Track E (main runs)
- **Связь:** `system_design §6` (metrics + benchmarks), `design/baselines.md`
  (baseline integration), `design/assistant-traj.md` (AssistantTraj adapter)

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
  - Baseline implementations (см. `design/baselines.md`)
  - AssistantTraj task construction (см. `design/assistant-traj.md`)

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
params пишет в ту же папку → replication явный, resume тривиальный (см. `design/main-runs.md §6`).

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

Детали orchestration — `design/main-runs.md`.

---

## Open questions

1. Token counter source: `@anthropic-ai/tokenizer` или request usage headers? Решение — B2.
2. Judge cache (для AssistantTraj LLM-judge) — persist на диск или re-run каждый раз?
   Решение — D4 после первых 10 judge runs (зависит от стабильности judge output'a).
3. Concurrent run safety — file locks на NDJSON append'ы или single-writer assumption?
   Default — single-writer; if E1/E2 параллельно → revisit.
