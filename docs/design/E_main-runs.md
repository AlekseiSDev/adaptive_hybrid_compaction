# Track E Design — Main Runs (Sweeps + Ablations)

> Track-level design для финальных экспериментов: main sweep, ablations, cache-hit subset.
> Phase plan — `system_design §7.2 Track E`. Тонкий слой над `design/B_eval-harness.md`:
> orchestration, cost management, replication, failure recovery, pre-flight checklists.

---

## Meta

- **Track:** E (E1 main sweep → E2 ablations → E3 cache-hit subset)
- **Wall-clock:** 4.5 дня
- **Бюджет:** ~$170 (E1 ~$120 + E2 ~$30 + E3 ~$20)
- **Зависит от:** A1–A6 (AHC ready), B1–B3 (harness), C1–C3 (baselines), D1–D4 (AssistantTraj)
- **Блокирует:** Track F (нужны числа для отчёта)
- **Связь:** `system_design §7.2 Track E` (phase plan source), `design/B_eval-harness.md §8` (sweep YAML schema), `design/B_eval-harness.md §6` (CostTracker — здесь активируется), `design/A_ahc-algorithm.md §2.1` (cache-hit target ≥ 60% — verified в E3)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный pre-flight gate на входе. E — execution layer,
> Verify здесь — gating checks (pre-flight dry-run, post-run audit, cost-tracker), а
> не unit-tests.

### Track E (после E3)

**Доступно:**
- `eval/sweeps/{main_e1,ablation_e2,cache_hit_e3}.yaml` — sweep definitions, committed.
- `benchmarks/runs/{main-sweep,ablations,cache-hit-subset}/` — per-(bench, config, seed)
  NDJSON records (raw — в `.gitignore`), плюс committed `summary.json` + `meta.json`
  для воспроизводимости.
- Полный numeric backbone отчёта Track F: accuracy / tokens / cost / cache-hit split
  по `(bench, baseline, seed)`, готовый к stat-aggregation.

**Demo:** показать `summary.json` main sweep — accuracy / tokens / cost split по
`(bench, baseline, seed)`; sweep — это и есть результат, demo = inspection summary.
Альтернатива — re-aggregation: `pnpm tsx scripts/aggregate.ts benchmarks/runs/main-sweep/`
re-derives `summary.json` из NDJSON (sanity-check для reviewer'а).

**Acceptance gate:** §9 post-run audit checklist пройден целиком — все
`summary.json` со `status: 'complete'`, `ErrorRecord` rate < 10% на любом
`(bench, config)`, statistical pipeline пробрасывает main deltas, cost actual vs
budget delta < 30%, cost-tracker circuit-breaker за run не triggered'ился.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 gating checks) |
|---|---|---|
| **E1** | `benchmarks/runs/main-sweep/` — 4 baselines × 4 benches × 2 seeds NDJSON + per-cell `summary.json`/`meta.json`; ~$120 spent | §8 pre-flight checklist PASS перед launch + §9 post-run audit PASS + `CostTracker` не halt'нул circuit-breaker |
| **E2** | `benchmarks/runs/ablations/` — 4 AHC configs × 2 benches × 2 seeds NDJSON + summaries; ~$30 spent; ahc_full numbers в пределах stderr от E1 reference | §8 упрощённый pre-flight PASS + §9 post-run audit PASS + ahc_full sanity-cross-check с E1 |
| **E3** | `benchmarks/runs/cache-hit-subset/` — n=10–15 tasks на Anthropic direct (Sonnet-4.6), `cache_read_input_tokens` field per turn; ~$20 spent | §8 упрощённый pre-flight PASS (dry-run: `cache_read_input_tokens > 0` на 2nd turn) + §9 post-run audit PASS |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track E`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы / артефакты, которые трогает или вводит фаза (в этом треке — sweep YAML, NDJSON records, `SweepBudget`).
- **TDD seed** — failing test / gating check, с которого фаза стартует (для E это чаще pre-flight / dry-run gate, не unit-test).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **E1** Main sweep (4 baselines × 4 benches × 2 seeds, ~$120, 3 дня) | A1–A6, B1–B3, C1–C3, D1–D4 | E2, F | §1, §2, §3, §4, §5, §6, §6.1, §8 | `eval/sweeps/main_e1.yaml`, `SweepBudget{sweep_id:'e1',budget_usd:120}`, NDJSON records per `(bench,config,seed)` | §8 pre-flight: dry-run 2 tasks × 4 benches PASS + cost circuit-breaker halt'ит при artificially low budget | §9 post-run audit (gate в F), §7 (только если E1 conf'ы пересекаются с E3 subset) |
| **E2** Ablation grid (4 AHC configs × 2 benches × 2 seeds, ~$30, 1 день) | E1 ahc_full (sanity baseline) | F | §2 (E2 deps), §3, §4, §5, §6, §6.1, §8 (упрощённый checklist) | `eval/sweeps/ablation_e2.yaml`, `SweepBudget{sweep_id:'e2',budget_usd:30}`, NDJSON per ablation config | dry-run 1 task × 2 benches на каждой ablation config PASS; ahc_full numbers из E1 в пределах stderr от reference | §9 post-run audit, §3 parallelization (E1 ∥ E2 option) |
| **E3** Cache-hit subset (n=10–15 tasks на Anthropic direct, Sonnet-4.6, ~$20, 0.5 дня) | A6, C2 (оба на Anthropic direct API) | F | §7 (E3-specific), §4, §6, §6.1, §8 (упрощённый checklist) | `eval/sweeps/cache_hit_e3.yaml`, `SweepBudget{sweep_id:'e3',budget_usd:20}`, output в `benchmarks/runs/cache-hit-subset/` | dry-run 2 tasks (AHC-full + Mastra OM + Anthropic-native compact) на Sonnet-4.6 → `cache_read_input_tokens` поле присутствует в response и > 0 на 2nd turn | §3 parallelization (concurrency=2 для Anthropic), `system_design §2.1` target ≥ 60% |

**Parallelization:** E3 — independent от E1/E2 (другой провайдер, отдельный rate-limit), может стартовать параллельно как только A6 + C2 готовы. E1 и E2 по default sequential (предсказуемость cost-tracker и file lock simplicity, §2); параллельно — option если OpenRouter concurrent rate-limit позволяет (§3) и E1 уходит > 36ч wall-clock (см. Open question 1).

**Orthogonal / deferred:**
- §9 Post-run audit — gate между E и F, не часть самих E-фаз; читается перед стартом F.
- §10 Open questions — revisit во время run'ов, не блокирует старт.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: plan-mode
разбивает фазу на task'и, прогресс трекается через TaskCreate / `implementation/<phase>.md`
по `templates/implementation_template.md`. Pseudocode и контракты остаются в design
doc как source of truth, не дублируются в implementation.

---

## 1. Scope

- **In**: run orchestration, sweep execution policy, cost monitoring, replication,
  failure recovery, cache-hit subset на Anthropic direct API.
- **Out**: harness implementation (Track B), baseline impl (Track C), статистика
  (живёт в `eval/stats.ts`, см. `design/B_eval-harness.md §5`).

---

## 2. Sweep dependencies

```
E1 (main sweep, ~$120)
   ├── requires: A6, B3, C1-C3, D4
   └── output: 4 baselines × 4 benches × 2 seeds

E2 (ablations, ~$30)
   ├── requires: E1 ahc_full (sanity baseline для AHC variants)
   └── output: 4 AHC configs × 2 benches × 2 seeds

E3 (cache-hit subset, ~$20)
   ├── requires: A6, C2 (оба на Anthropic direct API)
   └── output: cache hit rate numbers, n=10-15 tasks
```

E1 + E2 могут параллельно если бюджет позволяет concurrent rate-limits. Default —
sequential для предсказуемости cost-tracker и file lock simplicity.

---

## 3. Parallelization plan

OpenRouter rate-limits (verify at E1 start через `openrouter.ai/api/v1/auth/key`):
- Concurrent requests per key: типично 5–10.
- Per-model throughput: variable; для Gemini-3.1-Flash обычно щедро.

Стратегия:
- Default concurrency 5; upscale если no throttle errors first 10 tasks.
- Batch granularity — task-level (один task running до завершения).
- Не batch'им runs на уровне model API; harness orchestration параллелит на task-level.

Anthropic direct API (E3) — rate-limit более strict, concurrency 2.

---

## 4. Cost tracking

`CostTracker` (см. `design/B_eval-harness.md §6`) запускается на каждом sweep'е.
Дополнительно для Track E:

```typescript
type SweepBudget = {
  sweep_id: 'e1' | 'e2' | 'e3'
  budget_usd: number
  hard_halt_multiplier: number      // default 1.5
  warn_multiplier: number           // default 1.2
}
```

Halt poll'ится каждые 20 tasks. Если halt:
1. Текущие in-flight tasks завершают.
2. New tasks не запускаются.
3. Cost tracker записывает `status: 'partial'` в summary.json.
4. User notified через console + summary; resume возможен после ревизии params.

---

## 5. Replication strategy

- 2 seeds: 42 (primary), 43 (replication).
- Seed влияет на:
  - Task sampling (для LongMemEval / LoCoMo medium subset).
  - Synthetic top-up trajectories в AssistantTraj (если ещё догенерация).
  - Permutation tests (но это post-hoc, не run-time).
- Actor model: `temperature=0` где возможно → deterministic greedy decode. Не гарантирует
  bit-identical между provider calls, но shrink'ит variance.
- Bench-level seed handling — bench adapter знает что делать с seed (some benches
  fixed, others sample-based; `eval/adapters/<bench>.ts`).

Final results — mean ± stderr across seeds. Statsig — paired permutation p < 0.05
на главных дельтах (см. `system_design §2.3`).

---

## 6. Failure recovery

NDJSON persistence (см. `design/B_eval-harness.md §4`) делает resume тривиальным:

```bash
$ npm run sweep -- --plan main_e1 --resume
```

Resume logic:
1. Read `benchmarks/runs/<bench>/<config_id>/<seed>/records.ndjson`
2. Build set of completed `task_id`s
3. Skip those, run only missing

Idempotency: task identity = `(bench, task_id, config_id, seed)`. Если retry
партиально-failed run'а нужен — manual delete конкретной line из ndjson + resume.

### 6.1 Failure modes

| Failure | Recovery |
|---|---|
| Provider 5xx / network | Backoff 3 retries → record `ErrorRecord{kind:'api_error'}`, продолжить sweep |
| OpenRouter rate-limit | Backoff with jitter, no record; retry до 5 раз |
| Cost circuit-breaker hit | Halt new tasks, finish in-flight, summary status=partial |
| Worker process crash | Resume from NDJSON; lose at most concurrency-many tasks |
| Task takes > 10min wall-clock | Timeout → `ErrorRecord{kind:'timeout'}`, kill task |

---

## 7. E3 cache-hit subset

Отдельная среда — direct Anthropic API, не OpenRouter:

- Model: `claude-sonnet-4-6`
- Subset: 10–15 tasks из LongMemEval-Medium (берём подзадачи где гарантированно
  multi-turn ≥ 5, чтобы cache имел смысл).
- Configs: AHC-full + Mastra OM + Anthropic-native compact (3, не 4 — full-context
  при cache-hit нерелевантен).
- Метрика: `cache_read_input_tokens / total_input_tokens` per turn, averaged.
- Output: `benchmarks/runs/cache-hit-subset/`.

`system_design §2.1`: target cache hit rate ≥ 60% — здесь верифицируется.

---

## 8. Pre-flight checklist (E1)

Перед launch'ем main sweep:

- [ ] `./scripts/verify.sh` зелёный на всех Track A/B/C/D heads
- [ ] sweep definition committed в `eval/sweeps/main_e1.yaml`
- [ ] CostTracker `budget_usd: 120` зафиксирован
- [ ] OpenRouter API key прав/баланс проверен через auth endpoint
- [ ] Dry-run на 2 tasks из каждого бенча PASS (4 × 2 = 8 tasks, ~$2 spend)
- [ ] Git tag `pre-e1` для clean restart point
- [ ] Cost circuit-breaker tested на dry-run (artificially low budget — должен halt'ить)

Аналогичный checklist (упрощённый) для E2 и E3.

---

## 9. Post-run audit (after E1/E2)

Перед началом F (report):
- [ ] `summary.json` для каждого `(bench, config, seed)` существует и `status: 'complete'`
- [ ] No `ErrorRecord` rate > 10% на любом (bench, config) — иначе investigate
- [ ] Per-class breakdown скрипт (B3) PASS на AHC runs
- [ ] Statistical pipeline (paired permutation, bootstrap) пробрасывает все main deltas
- [ ] Cost actual vs budget delta < 30%

---

## Open questions

1. E1 / E2 параллельно или sequentially? Default sequential; revisit если E1 уйдёт
   в > 36ч wall-clock.
2. E3 на Sonnet-4.6 или Haiku-4.5 для cost — нужен ли capability match с E1 actor
   (Gemini-3.1-Flash)? Sonnet-4.6 — best cache implementation. Решение — старт E3.
3. Timeout per task — 10min hard cap. Достаточно для medium-traj? Verify dry-run.
