# main_e1_text_lme_mt_n50 — n=50 audit

> Generated 2026-05-22, **post-fix update 2026-05-24** (см. `## Post-fix update`
> в конце документа). Companion sweeps `main_e1_text_lme_mt_n50` (4 cells)
> и `main_e1_text_lme_mt_n50_mastra_agent` (1 cell). Single seed=42, actor
> `openai/gpt-5.4-mini`, bench `lme-multiturn` (Mode A replay, 41-63 turns).
>
> Repo state at original run: commit `a10c4d2` + uncommitted Phase 8 WIP в
> `src/core/thresholds.ts` (default OBSERVER_THRESHOLD 8000 → 30000),
> `src/eval/runner.ts` (mastra-agent registration),
> `src/eval/baselines/mastra_agent.ts` (Track I phase I1 landed).
> **The pre-fix Results table below is a historical baseline** documenting
> the architectural defect that motivated H Phase 9 fix
> (commits `fe10ed9` + `d4c2746`, 2026-05-22..24).
>
> Run command:
> ```
> pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text_lme_mt_n50.yaml \
>   --concurrency=5 --max-tasks-per-cell=50
> pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text_lme_mt_n50_mastra_agent.yaml \
>   --concurrency=5  # ⚠️ забыли --max-tasks-per-cell=50, прошёл весь n=120
> ```

## Scope

Один honest head-to-head на lme-multiturn:
- **AHC** в двух режимах observer threshold: 30000 (current default per Phase 8
  decision) и 128000 (≈ half of user-stated 256k gpt-5.4-mini context, режим
  "AHC когда контекст не давит").
- **Mastra OM** — frozen competitor, Mastra ObservationalMemory chassis.
- **Mastra Agent** (Track I phase I1, новый baseline) — Mastra `Agent` + Memory,
  text-bench без tools (structurally ≈ Mastra OM per design §2.2 asymmetry).
- **full_context** — no compaction reference.

## Results

| config | n | input_tok | cache_read | cache% | **acc** | cost ($) | err_rate | obs/off/rec |
|---|---|---|---|---|---|---|---|---|
| **full_context** | 50 | 143,495,377 | 125,941,504 | 87.8% | **0.540** | 109.74 | 0.0% | 0/0/0 |
| **mastra_om** | 50 | 48,519,906 | 32,114,176 | 66.2% | **0.520** | 26.50 | 4.0% | 0/0/0 |
| **mastra-agent** (Track I) | 120 | 107,322,750 | 67,414,016 | 62.8% | **0.400** | 60.45 | 7.5% | 0/0/0 |
| **ahc_full_obs128k** | 50 | 22,241,839 | 3,660,032 | 16.5% | **0.120** | 18.85 | 0.0% | 0/0/0 |
| **ahc_full_obs30k** | 120 | 53,843,417 | 9,054,976 | 16.8% | **0.108** | 45.45 | 0.0% | 0/0/0 |

Cell-hash → config_id mapping подтверждён через `meta.json`:
- `17e02d3b263d9a00` = full_context
- `7e22cf2fb044d669` = mastra_om
- `b011165ce1c19052` = ahc_full_obs30k
- `ccb56c2176ade9dc` = ahc_full_obs128k
- `6edd5e02b1e8cda3` = mastra-agent (sweep B)

Total cost: **$260.98** ($141.99 sweep A restart + $60.45 sweep B + ~$58.54
от первого sweep A run до kill — ahc_full_obs30k полностью прошёл n=120 за
$45.45 + первые 25 mastra_om ≈ $13).

## Caveat — heterogeneous n

Из-за пропущенного `--max-tasks-per-cell` flag при первых запусках:
- `ahc_full_obs30k` и `mastra-agent` имеют **n=120** (полная baked subset).
- Остальные 3 cells — `n=50` как по плану.

Comparison остаётся валидным: один и тот же baked subset `loadTasks(seed=42)`
итерируется в одном и том же порядке; первые 50 tasks ⊂ первые 120 на обоих
cells. Для apples-to-apples comparison первых 50 — нужен subset-filter в
aggregator (TODO для будущей сессии, если решим что важно).

## Observations

### 1. AHC observer fire-rate = 0/0 на обоих threshold

Aggregator column `obs/off/rec` = `0/0/0` для **обоих** AHC cells. Проверка
первого record из `ahc_full_obs30k` (task `01493427`, 48 turns):

```
total_compaction_events: 0
total_recall_events:    0
class_signal samples:   [{'class':'mixed', 'confidence':0/1}, ...]
totals: {input: 485638, output: 9486, cache_read: 132608}
```

Observer не fire'ил НИ РАЗУ за 48 turns при OBSERVER_THRESHOLD=30000.
Cumulative tokens per turn накапливаются до ~485k к концу task (input для
LLM grows quadratically с history), но **per-turn** input при K_RECENT=6
sessions × ~2.6k = ~15.6k токенов, что НИЖЕ 30k threshold. То есть observer
проверяет per-step accumulated tokens в Tier-3, не cumulative.

Это **критическое open question**: правильно ли мы интерпретируем
OBSERVER_THRESHOLD после Phase 8 raise (8000 → 30000)? При 30k observer не
fire'ит почти никогда на lme-multiturn (Tier-3 capacity ≈ 15-20k tokens),
делая AHC по сути **K_RECENT=6 drop-tail policy без summarisation** — теряет
все sessions старше last 6.

### 2. AHC@30k acc=0.108 vs Mastra OM acc=0.520

Драматическая разница в acc при близких input/cost. AHC@30k и Mastra OM оба
работают в ~50M input envelope (per Phase 8 decision rationale), но:
- Mastra OM сохраняет answer-bearing sessions через ObservationalMemory (LLM
  decides что сохранить).
- AHC с observer never-firing просто drops sessions старше K_RECENT.

→ На lme-multiturn answer находится в случайной session (sometimes early,
sometimes mid), AHC без active observer теряет её systematically.

### 3. AHC@128k input=22M < AHC@30k input=54M

Counter-intuitive: при более **слабом** observer threshold (128k vs 30k),
input должен быть БОЛЬШЕ (observer fire'ит реже = меньше compaction = больше
tokens). А мы видим input **МЕНЬШЕ** в 2.4x.

Hypothesis: K_RECENT drop-tail + offload работают независимо от observer;
при 128k threshold cumulative-history reflection ещё реже trigger'ится →
fewer recall_tool injections + fewer tier rotations → меньше overhead в
prompt → меньше total input. Это требует investigation в audit doc D / H.

### 4. full_context acc=0.540 — лидер

FC keeps full cumulative history, cache% 87.8% (OpenRouter auto-cache на
stable prefix). Cost $109.74 ≈ $2.20/task. На lme-multiturn где answer
distributed across sessions, FC strategy ("keep everything") выигрывает.

### 5. mastra-agent acc=0.400 vs mastra_om acc=0.520

12pp ниже Mastra OM. Возможные причины:
- err_rate 7.5% (9/120 tasks): connect timeout errors к OpenRouter в Mastra
  internal AI SDK binding (timeout=10s default), 2 judge LLM network failures.
  Эти tasks scored 0 вместо retry до success.
- Без tools на text-bench mastra-agent ≈ mastra_om по structure (single
  `agent.generate()` per step), но Agent default может differ в memory
  serialization (system message handling, thread state).

При cross-check на n=50 (subset) разница может уменьшиться. Investigation
TODO в Track I phase I3 audit.

### 6. Mastra OM err_rate=4.0% (2/50)

Тоже connect timeout-related. Mastra binding на OpenRouter менее стабилен
чем direct AI SDK call (FC=0%, AHC=0%). Для Mastra-based baselines нужен
retry-with-backoff или timeout bump в `src/eval/baselines/mastra_*.ts`.

## Decisions / TODO

1. **Investigate AHC observer fire mechanics при threshold=30000**. На
   lme-multiturn observer never fires → AHC effectively K_RECENT-only.
   Reconcile с Phase 8 decisions.md: "30000 sets AHC's pre-compact window in
   the same envelope as Mastra OM" — на каких задачах был замер? Если на
   smaller n / shorter trajectories, conclusion не generalizes.
2. **Backfill subset-aware aggregator** для apples-to-apples при разных n
   (subset records by canonical task-id order, не all-or-nothing).
3. **Mastra connect-timeout мiti­gation**: bump default timeout в
   `mastra_om.ts` / `mastra_agent.ts`, либо wrap в retry с jitter.
4. **Не commit'ить** записи `benchmarks/runs/main_e1_text_lme_mt_n50*/`
   (per memory `feedback_experiments_not_in_git`). Этот audit doc — durable
   запись чисел.

## Provenance

| field | value |
|---|---|
| Run dates | 2026-05-22 (pre-fix), 2026-05-24 (post-fix AHC reruns) |
| Bench | lme-multiturn (Mode A replay, 41-63 turns; 120 baked tasks subset, seed=42) |
| Actor model | `openai/gpt-5.4-mini` (via OpenRouter) |
| Judge model | `openai/gpt-5.4-mini` (sweep cost includes judge $0.28 total) |
| Sweep YAMLs | `eval/sweeps/main_e1_text_lme_mt_n50.yaml`<br>`eval/sweeps/main_e1_text_lme_mt_n50_mastra_agent.yaml` |
| Repo commits | `a10c4d2` (pre-fix), `fe10ed9` + `d4c2746` (H Phase 9 fix + mirror coupling) |
| Aggregator | `scripts/sanity-aggregate.ts` (per cell run dir argument) |

---

## Post-fix update (2026-05-24)

After landing H Phase 9 (commits `fe10ed9` + `d4c2746`):
- `fe10ed9` — Tier-2 cross-turn persistence (`Map<SessionId, Tier2>` в adapter)
  + adaptive Tier-3 token budget (walk-to-budget instead of message-count cap).
- `d4c2746` — adapter implicit coupling: `TIER3_TOKEN_BUDGET` mirrors
  `OBSERVER_THRESHOLD` when caller overrides one without the other (caught
  on `ahc_full_obs128k` cell where bug surfaced as Tier-3 frozen at 30k tail).

Re-ran AHC cells only via `--force=ahc_full_obs30k,ahc_full_obs128k --max-tasks-per-cell=10`.
`mastra_om` / `full_context` / `mastra-agent` cells unchanged (the fix touches
only AHC pipeline; their NDJSON resume picked existing records).

### Post-fix results

| config | n | input_tok | cache_read | cache% | **acc** | cost ($) | err_rate | obs/off/rec |
|---|---|---|---|---|---|---|---|---|
| **full_context** (unchanged) | 50 | 143,495,377 | 125,941,504 | 87.8% | **0.540** | 109.74 | 0.0% | 0/0/0 |
| **mastra_om** (unchanged) | 50 | 48,519,906 | 32,114,176 | 66.2% | **0.520** | 26.50 | 4.0% | 0/0/0 |
| **mastra-agent** (unchanged) | 120 | 107,322,750 | 67,414,016 | 62.8% | **0.400** | 60.45 | 7.5% | 0/0/0 |
| **ahc_full_obs30k** post-fix | 10 | 3,943,149 | 2,034,944 | 51.6% | **0.200** | 11.95 | 0.0% | **10/0/0** |
| **ahc_full_obs128k** post-mirror | 10 | 25,443,464 | 21,677,056 | 85.2% | **0.200** | 22.15 | 0.0% | **9/0/0** |

### Per-task comparison (first 10 tasks, apples-to-apples)

| task | FC | mastra_om | AHC@30k | AHC@128k |
|---|---|---|---|---|
| 01493427 | 1 | 1 | 0 | 0 |
| 07741c44 | 1 | 0 | 0 | 0 |
| 07b6f563 | 0 | 1 | **1** | **1** |
| 0862e8bf | 1 | 1 | 0 | 0 |
| 0862e8bf_abs | 1 | 1 | **1** | **1** |
| 099778bb | 0 | 1 | 0 | 0 |
| 09d032c9 | 0 | 0 | 0 | 0 |
| 0a34ad58 | 1 | 1 | 0 | 0 |
| 0bc8ad93 | 0 | 0 | 0 | 0 |
| 0db4c65d | 0 | 0 | 0 | 0 |
| **Σ/10** | **5** | **6** | **2** | **2** |

### Post-fix observations

1. **Observer теперь fires** — 10/10 (AHC@30k) и 9/10 (AHC@128k) records имеют
   `compaction_events.length > 0`. Pre-fix было 0/120 на обоих. Архитектурный
   fix верифицирован: Tier-2 persists cross-turn, Tier-3 grows к budget,
   observer срабатывает на overflow.

2. **AHC acc улучшилась на subset**: AHC@30k 0.108→0.200, AHC@128k 0.120→0.200
   на первых 10 задачах. Sample size мал (n=10), variance высокая.

3. **AHC@128k input 25.4M ≈ 88% от FC (28.7M на эти 10 задач)**. Cache% 85.2%
   ≈ FC's 87.8%. Структурно AHC@128k теперь близок к FC по объёму контекста,
   но acc 0.20 vs FC 0.50. Разрыв 30pp **не объясняется** truncation — это
   **lossy observer extraction**.

4. **Confabulation example (task 01493427)**: ground truth = "user added
   25 postcards". FC отвечает "25" ✓. Обе AHC отвечают "17" ✗. Observer
   видимо вытянул "17" в observation на каком-то fire (возможно из старой
   session где упоминалось "17") и потерял точный "25" при clipping Tier-3.
   Это **отдельный workstream — calibration observer extraction prompt**
   (не Tier-2 persistence fix).

5. **Mirror fix critical**: до d4c2746 AHC@128k имел input 12.2M (Tier-3
   capped at static 30k default) — выглядело "малый context = плохой acc".
   После mirror input вырос до 25.4M (Tier-3 cap=128k), cache% с 23.9%→85.2%,
   но acc остался 0.20. То есть архитектура исправлена, но **AHC observer
   pipeline на lme-multiturn систематически проигрывает FC даже при близком
   объёме контекста** — root cause = observation extraction lossy.

### Decisions / TODO updated

1. ~~**Investigate AHC observer fire mechanics при threshold=30000**~~ → fixed
   in H Phase 9 (`fe10ed9`).
2. ~~**TIER3_TOKEN_BUDGET implicit coupling bug**~~ → fixed in `d4c2746`.
3. **NEW: Observer extraction quality on lme-multiturn**. Pre/post-fix AHC
   loses precise facts (numeric answers, specific names) even при близком
   context size к FC. Investigate observer prompt
   (`src/core/observerPrompt.ts:OBSERVER_PROMPT_TEMPLATE`) — может нужны:
   - Verbatim quote retention в observations (текущий format `- timestamp
     (high|med|low) statement` lossy)
   - Stricter "include exact numbers/names" instruction
   - Recall_tool на observation lookup при answer-bearing query
4. **Full n=50 re-run AHC** (~$60-100) — deferred. Current n=10 reruns
   достаточны для architectural verification fix'а; precise acc delta vs
   FC требует bigger sample, но качественный gap (lossy observer) already
   видимо.
5. **Backfill subset-aware aggregator** (carry-over from pre-fix).
6. **Mastra connect-timeout mitigation** (carry-over from pre-fix).
