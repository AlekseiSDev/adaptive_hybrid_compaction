# Track C Design — Baselines Integration

> Track-level design для трёх baseline wrappers, гоняющихся в общем eval harness.
> Реализуется в `src/eval/baselines/`. Phase plan — `system_design §7.2 Track C`.

---

## Meta

- **Track:** C (C1 Mastra OM → C2 Anthropic native → ~~C3 Full context~~ ships in B2)
- **Wall-clock:** 2.5 дня (3.5 − 0.5 для C3, ушедшего в B2)
- **Зависит от:** B1 (harness baseline) + B2 (LLMClient, Baseline interface,
  `buildRunnerFromBaseline` helper, OpenRouter wire), `design/B_eval-harness.md`
  (RunRecord shape + §6 CostTracker active)
- **Блокирует:** Track E (нужны все 3 baselines для sweep E1; `full_context` уже
  доступен после B2)
- **Связь:** `system_design §6.5` (baseline list + rationale), `decisions.md 2026-05-13`
  (B2 entries — `full_context` ships in B2, Runner=outer/Baseline=inner)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе.

### Track C (после C3)

**Доступно:**
- `src/eval/baselines/{mastra_om,anthropic_compact,full_context}.ts` + `index.ts`
  re-export; каждый реализует `Baseline` interface из §1.
- Harness ресолвит baseline по строковому ключу из sweep YAML
  (`baseline: mastra_om | anthropic_compact | full_context`); selection wiring
  живёт рядом с B1 harness factory.

**Demo (smoke sweep):** `pnpm exec ahc-eval run eval/sweeps/smoke-baselines.yaml`
— 3 baseline'а × 1 task; каждый task делает ≥ 1 turn. Для каждого baseline'а в
NDJSON output ожидаем non-empty `response` и корректный `scratch` shape
(`thread_id` для mastra_om, `compacted_history_id` для anthropic_compact, пустой
для full_context). CLI `ahc-eval` создаётся в B1; если CLI ещё не готов на момент
C3 — equivalent через `pnpm tsx scripts/run-sweep.ts eval/sweeps/smoke-baselines.yaml`.

**Acceptance gate:** `./scripts/verify.sh` зелёный + step()-roundtrip integration
test для каждого baseline'а проходит + smoke sweep NDJSON содержит запись с
`baseline ∈ {mastra_om, anthropic_compact, full_context}` и соответствующим
`scratch` shape per §1.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **C1** | `src/eval/baselines/mastra_om.ts`; harness принимает `baseline: mastra_om`, `state.scratch.thread_id` сохраняется между turns; PG testcontainer поднимается per task | `pnpm exec vitest run src/eval/baselines/mastra_om.test.ts` (testcontainers integration, medium-weight: ~docker required, skip mark если нет docker) + `./scripts/verify.sh test:unit` |
| **C2** | `src/eval/baselines/anthropic_compact.ts`; `compact_20260112` strategy attached; `telemetry.compaction_events[]` несёт `before/after` bytes | `pnpm exec vitest run src/eval/baselines/anthropic_compact.test.ts --live` (требует `ANTHROPIC_API_KEY`; recorded fixtures как fallback в `--no-live` режиме до момента когда API shape stable) |
| **C3** | **Ships in B2** (см. `decisions.md 2026-05-13` B2 entries): `src/eval/baselines/full_context.ts`; pass-through accumulation, `state.history.length == 2*N` после N turns; OpenRouter wire через `LLMClient` (B2) | `pnpm exec vitest run src/eval/baselines/full_context.test.ts` |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track C`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы / интерфейсы из §1 (`Baseline`, `BaselineState`), которые фаза реализует.
- **TDD seed** — failing test, с которого фаза стартует (Red в TDD-цикле).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **C1** Mastra OM baseline (2 дня) | B1, §1 | E1 | §4, §4.1, §4.2, §4.3 | `Baseline` impl `mastra_om`; `BaselineState.scratch.thread_id`; `RunRecord.scratch.mastra_config` (§4.3) | step()-roundtrip: prepare → step(userMsg) → response message non-empty, `thread_id` сохранён в state.scratch между turns | §4.4 failure modes; §5 config_id; `B_eval-harness.md §2` RunRecord shape |
| **C2** Anthropic native compact wrapper (1 день) | B1, §1, verify `compact_20260112` shape (§3) | E1 | §3, §3.1 | `Baseline` impl `anthropic_compact`; `BaselineState.scratch.compacted_history_id` | compaction event logging: после step с large history `telemetry.compaction_events[].type='reflection'` имеет before/after bytes (§3.1) | §3.2 failure modes; §5 config_id |
| ~~**C3** Full context baseline (0.5 дня)~~ **Ships in B2** | B1, §1, B2 `LLMClient` | E1 | §2 | `Baseline` impl `full_context`; pass-through `state.history` | history accumulation: после N step'ов `state.history.length == 2*N` (user + assistant per turn), ничего не trim'ается | §2.1 failure modes (context window exceeded); §5 config_id; `B_eval-harness.md §2` Baseline contract; `decisions.md 2026-05-13` |

**Parallelization:** `C1/C2/C3` независимы между собой после `B1` — все три реализуют один и тот же `Baseline` interface из §1 и могут разрабатываться параллельными сабагентами. Все три блокируют `E1` (main sweep по `design/E_main-runs.md §2` требует все 3 baseline'а).

**Orthogonal / deferred:**
- §5 Cross-baseline integration — читается один раз перед C1 (config_id naming convention), не требует отдельной фазы.
- §1 Common baseline contract — baseline reference, читаем перед любой из C1/C2/C3.
- Open questions (Mastra version pin, Anthropic API shape verify) — resolved at-phase-start, не выделяем в отдельную фазу.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Common baseline contract

```typescript
interface Baseline {
  readonly name: string
  prepare(task: Task): BaselineState
  step(state: BaselineState, userMsg: Message): Promise<{
    response: Message
    state: BaselineState
    telemetry: TurnRecord
  }>
  finalize?(state: BaselineState): Promise<void>   // optional cleanup
}

type BaselineState = {
  task_id: string
  history: Message[]                    // baseline-managed
  scratch?: Record<string, unknown>     // baseline-specific (e.g. mastra thread_id)
}
```

`Conversation` и `Message` — из `core/types.ts` (см. `A_ahc-algorithm.md §2.4`).
Baseline владеет собственным state — harness вызывает `step` per turn, агрегирует
`TurnRecord`'ы в `RunRecord` через telemetry pipeline (см. `design/B_eval-harness.md §2`).

**Bridge к `Runner` (B1):** `Baseline` — inner per-turn contract; `Runner` — outer per-task
contract которым оперирует `runSweep`. `src/eval/baseline.ts` экспортирует
`buildRunnerFromBaseline(baseline: Baseline): Runner` — loop'ит по messages из
`Conversation`, aggregate'ит `telemetry: TurnRecord[]` в `RunnerResponse`. C1/C2/C3
реализуют `Baseline`, регистрируются через `defaultRunnerRegistry` через helper.
Контракт зафиксирован в `decisions.md 2026-05-13` (B2 entries — Runner=outer / Baseline=inner).

---

## 2. Full Context baseline (C3 — implemented in B2)

> **Status:** Реализован в B2 как vertical-slice deliverable (де-факто закрывает C3).
> Файл: `src/eval/baselines/full_context.ts`. Использует `LLMClient` + OpenRouter wire
> из `src/eval/llm.ts` (B2). `defaultRunnerRegistry` resolves `baseline: full_context`
> через `buildRunnerFromBaseline(fullContextBaseline(llmClient))`. См. `decisions.md
> 2026-05-13` B2 entries для обоснования cross-track placement.

Тривиальный pass-through: всё history → provider → response.

```typescript
class FullContextBaseline implements Baseline {
  readonly name = 'full_context'

  async step(state, userMsg) {
    state.history.push(userMsg)
    const response = await provider.complete({
      model: state.scratch.model,
      messages: state.history,
    })
    state.history.push(response.message)
    return {
      response: response.message,
      state,
      telemetry: collectTelemetry(response),
    }
  }
}
```

Назначение — upper-bound accuracy + sanity check'и. Если AHC проигрывает full context
на > 20% на каком-то бенче — что-то сломано в core compaction. Wall-clock: 0.5 дня.

### 2.1 Failure modes

| Failure | Mitigation |
|---|---|
| Context window exceeded (long traj) | Запись `ErrorRecord{kind:'api_error'}`; task terminated; expected на τ-bench tail |
| API rate-limit | Exponential backoff up to 3 retries; затем `ErrorRecord` |

---

## 3. Anthropic native `compact_20260112` (C2)

Wrapper над Anthropic Messages API с server-side компакцией. Прозрачно для wrapper
— Anthropic держит compacted history internally.

```typescript
class AnthropicNativeBaseline implements Baseline {
  readonly name = 'anthropic_compact'

  async step(state, userMsg) {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      messages: state.history.concat(userMsg),
      metadata: { compact_strategy: 'compact_20260112' },
      tools: state.scratch.tools,
    })
    // Anthropic возвращает compacted_history_id в response.metadata;
    // на следующем step мы можем передавать delta + id вместо полного history.
    state.scratch.compacted_history_id = resp.metadata?.compacted_history_id
    return { response: resp.message, state, telemetry: collectTelemetry(resp) }
  }
}
```

**Verify at C2 start**: точная shape `compact_20260112` API на момент старта (2026-05-12+).
Если API изменилась — investigation doc, ревизим scope.

### 3.1 Что важно замерить отдельно

Drop tool_results после compaction (codex#14589 показал 0% survival): логировать
`compaction_events[].type='reflection'` с before/after bytes, чтобы post-hoc видно
было насколько агрессивно server-side compaction резал tool outputs.

### 3.2 Failure modes

| Failure | Mitigation |
|---|---|
| `compact_20260112` strategy unavailable / deprecated | Investigation doc; potentially drop baseline или switch на newest strategy |
| Server-side state lost (compacted_history_id expired) | Fallback на full history передачу; log warning |

Wall-clock: 1 день.

---

## 4. Mastra OM (C1, main competitor)

Mastra OM как library, не отдельный сервис. Default config с observational memory enabled.

```typescript
import { Mastra, Agent, Memory } from '@mastra/core'

class MastraOMBaseline implements Baseline {
  readonly name = 'mastra_om'
  private agent: Agent

  constructor(config: MastraConfig) {
    const memory = new Memory({
      storage: config.storage,            // см. §4.1
      observer: defaultObserver,
    })
    this.agent = new Agent({ memory, model: config.model })
  }

  async prepare(task) {
    return {
      task_id: task.task_id,
      history: [],
      scratch: { thread_id: `mastra_${task.task_id}` },
    }
  }

  async step(state, userMsg) {
    // Mastra owns conversation state internally via thread_id;
    // мы передаём только incoming userMsg, agent читает history из memory.
    const resp = await this.agent.generate({
      thread_id: state.scratch.thread_id,
      message: userMsg,
    })
    return { response: resp.message, state, telemetry: collectTelemetry(resp) }
  }

  async finalize(state) {
    // Optional: cleanup thread, dump memory snapshot для debug
  }
}
```

### 4.1 Storage

Mastra Memory требует storage adapter. Опции:
- **PG via testcontainers** — ephemeral; startup overhead ~1s per task. Default,
  если SQLite не работает.
- **SQLite** — если Mastra v6 поддерживает; cheaper, no docker dependency.

**Verify at C1 start**: какие storage adapter'ы exposed в `@mastra/core` на момент C1.
Если только PG — testcontainers. Если SQLite — preferred (faster CI).

### 4.2 Deterministic replay

Mastra Observer вызывает LLM → недетерминизм. Меры:
- `temperature=0` на provider calls (где Mastra exposed это).
- Замораживаем Mastra version в `package.json` точечно (без caret).
- Полный bit-identical replay не гарантирован → для replication полагаемся на
  2 seeds + bootstrap CI, не на exact reproducibility.

### 4.3 Config snapshot

Записываем full Mastra config в `RunRecord.scratch.mastra_config` для reproducibility.

### 4.4 Failure modes

| Failure | Mitigation |
|---|---|
| PG testcontainers не поднимается на CI | Local-only run; CI skip с явным флагом |
| Mastra Observer falls (provider error during compaction) | Mastra обычно fall back на trimming; log compaction_event с пометкой |
| Thread state corruption между tasks | Unique thread_id per task; finalize cleanup; никогда не reuse'им |

Wall-clock: 2 дня.

---

## 5. Cross-baseline integration в harness

Harness sees все три через `Baseline` interface. AHC оборачивается аналогично, но
живёт в `src/adapters/ai-sdk-v6.ts` и подключается через ту же contract pattern.

`config_id` (см. `design/B_eval-harness.md §4`) для baselines:
- `full_context__gemini-3-flash-preview`
- `anthropic_compact__sonnet-4-6`
- `mastra_om__gemini-3-flash-preview__libsql__1.32.1`

---

## Open questions

1. Mastra version pin — выбрать stable major перед C1 (зависит от того, что доступно).
2. Anthropic native compact session-id передача между turns — точная shape API
   (verify at C2 start).
3. Full context на τ-bench retail medium — будут ли context-window-exceeded errors?
   Если > 30% tasks — добавить sliding-window fallback как separate variant? **No**:
   `system_design §6.5` явно дропнул sliding-window; вместо этого фиксируем errors
   как negative result в Discussion.
