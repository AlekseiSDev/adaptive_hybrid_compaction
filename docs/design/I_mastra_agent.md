# Track I Design — `mastra-agent` baseline (full Mastra Agent + tools)

> Track-level design для нового baseline'а `mastra-agent` — Mastra `Agent` с
> зарегистрированными tools и нативным multi-step loop'ом. Прогоняется на трёх
> mt-style бенчах (`assistant-traj`, `lme-multiturn`, `tau-bench-retail-med`).
> Реализуется в `src/eval/baselines/mastra_agent.ts` +
> `src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts`. Phase plan —
> `system_design §7.2 Track I` (добавляется в Step 0 фазы I1).

> **Prereq.** Перед стартом I1 — добавить scope-row в `system_design.md §7.2` и
> routing-entry в `docs/index.md` (одним PR с этим документом, см. Phase map → I1).

---

## Meta

- **Initiative:** Track I (I1 mastra-agent baseline scaffold → I2 tau-bench Mastra adapter → I3 sweep + audit row)
- **Wall-clock:** ~4 дня
- **Бюджет:** ~$15-25 на live smoke + sweep (см. §5 budget)
- **Зависит от:** `mastra_om` (`src/eval/baselines/mastra_om.ts` — template для Memory wiring), `tau-bench-retail/agent-runner.ts` (template для tau loop shape), Mastra Agent tool API (внешний; investigation в Step 0 I2)
- **Блокирует:** ничего hard — additive baseline. F-report (Track F) при наличии чисел получает cross-framework Pareto.
- **Связь:** `decisions.md 2026-05-13 E0` (текущая асимметрия baselines × tau), `docs/runs/baselines_frozen.md` Tau-bench retail section (текущий tau результат — `tau_bench_agent` vanilla vs `tau_bench_agent_ahc`, оба acc 0.100), `docs/design/C_baselines.md §4` (исходный `mastra_om` design)

---

## Outcomes

### Track I (после I3)

**Что становится видимым:**
- `mastra-agent` baseline registered в runner registry (`src/eval/runner.ts`) и sweep YAML schema (резолвится по строке `baseline: mastra-agent`).
- Прогон через `eval/sweeps/main_e1_mastra_agent.yaml` даёт NDJSON в
  `benchmarks/runs/main_e1_mastra_agent/<bench>/<config_hash>/<seed>/`.
- Строки `mastra-agent` для каждого из трёх бенчей (`n / input_tok /
  cache% / acc / total_$`) лежат в `docs/runs/baselines_frozen.md`
  (Text benches + Tau-bench sections) с inline-narrative по Mastra Memory
  disclaimer. Per-audit doc `i_mastra_agent_audit.md` retired 2026-05-26
  — full original в `git log --diff-filter=D docs/runs/`.

**Demo (e2e smoke):**
```bash
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_mastra_agent.yaml --concurrency=1
# 3 bench × 1 task × 1 seed = 3 records, ~$2-3, ~5 min.
# Should produce NDJSON with response, totals.input>0, cost_usd>0 для всех 3.
```

**Acceptance gate:**
- `./scripts/verify.sh` зелёный.
- I-smoke test (`pnpm exec vitest run src/eval/baselines/mastra_agent.live.test.ts`)
  завершает по одной траектории каждого бенча end-to-end без exception'ов,
  acc field присутствует (значение может быть 0 или 1 — главное что pipeline
  не сломался).
- На `tau-bench-retail-med` Mastra Agent делает **≥ 1 успешный tool call**
  (env state мутируется хотя бы одним из 10 retail tools) — иначе baseline
  не считается интегрированным.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify |
|---|---|---|
| **I1** Mastra Agent text-bench baseline | `src/eval/baselines/mastra_agent.ts` (Baseline interface impl; Memory + Agent + recall_tool_result registered, retail tools — нет); registered в runner registry; passes step()-roundtrip integration test на synthetic + один live LME task | `pnpm exec vitest run src/eval/baselines/mastra_agent.test.ts` (unit) + `pnpm exec vitest run src/eval/baselines/mastra_agent.live.test.ts -t "lme"` (1 lme-multiturn task, ~$0.50) |
| **I2** Mastra Agent tau-bench adapter | `src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts`; 10 retail tools переведены из AI SDK `tool()` format в Mastra tool-API; user-sim alternation сохранена; env state мутируется через closures; registered как baseline `mastra-agent` на tau | `pnpm exec vitest run src/eval/adapters/tau-bench-retail/mastra-agent-runner.test.ts` (unit on tool translation) + live smoke: 1 retail episode end-to-end, ≥1 tool call, reward computed |
| **I3** Sweep run + audit | `benchmarks/runs/main_e1_mastra_agent/<bench>/...` populated; per-bench строки + Mastra Memory disclaimer лежат в `docs/runs/baselines_frozen.md` (Text benches + Tau-bench sections); `i_mastra_agent_audit.md` retired 2026-05-26 (см. git log) | `pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_mastra_agent/` показывает 3 cells со status=complete |

---

## Phase map

Source of truth по фазам — `system_design §7.2 Track I` (добавляется одним PR с этим документом). Колонки см. в `docs/templates/track_design_template.md`.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **I1** Mastra Agent text-bench scaffold (1 день) | `mastra_om.ts` (template), §2.1, §2.3 | I2, I3 | §3, §3.1, §3.2 | `Baseline` impl `mastra-agent` (text-bench shape); `BaselineState.scratch.mastra_agent_config` (§3.3) | failing unit: `MastraAgentBaseline.step(userMsg)` возвращает `response.text.length > 0` + telemetry с `input_tokens > 0` + `cost_usd > 0` (Mastra cost bubbling fix from `5777796` сохраняется) | §3.4 failure modes; `B_eval-harness.md §2` RunRecord; `C_baselines.md §4` (отличия от `mastra_om`) |
| **I2** Tau-bench Mastra adapter (2 дня) | I1; `tau-bench-retail/agent-runner.ts` (template); §4 (investigation Mastra tool API + closures over env state — Step 0) | I3 | §4, §4.1, §4.2, §4.3 | `runTauEpisodeMastra(episode, deps)` mirror sig от `runTauEpisode`; tool-translation helper `aiSdkToolToMastra(tool)`; registered baseline string `mastra-agent` на bench=`tau-bench-retail-med` | failing test: одна retail episode (smoke task `tau_smoke_001` или real episode at maxSteps=8) проходит loop, env state имеет ≥1 мутацию (`expected.orders` или `expected.users` diff non-empty) | §4.4 failure modes; `D_assistant-traj.md` (хотя не задействован — для context); `tau-bench-retail/types.ts` (EnvState, Episode) |
| **I3** Sweep run + audit doc (0.5 день) | I1, I2 | F-report (опционально) | §5 sweep YAML; §6 acceptance / freeze rules | `eval/sweeps/main_e1_mastra_agent.yaml`; per-bench рядки в `baselines_frozen.md` | pre-flight: `pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_mastra_agent.yaml --dry-run --n-per-cell=1` returns 0; post-run: `sanity-aggregate` показывает 3 status=complete cells | `docs/runs/baselines_frozen.md` (Mastra на tau уже represented в Tau-bench section) |

**Parallelization:** I1 → I2 строго последовательны (I2 наследует Mastra-config из I1). I3 ждёт обе. I1 параллелится с любым не-Mastra Track-H sweep'ом.

**Orthogonal / deferred:**
- Cross-model Mastra (Sonnet / Gemini вместо gpt-5.4-mini) — orthogonal; добавляется как I-phase extension если cross-model сравнения попросят в F-report.
- Mastra Workflows / steps API (вместо Agent) — out of scope: мы тестируем agent-loop, не оркестрацию.

**Step 0 (одним PR с этим docом):**
- Добавить scope-row `Track I` в `system_design.md §7.2`.
- Добавить routing-entry в `docs/index.md` секция "Track-level design docs".
- Добавить `Mastra Agent (mastra-agent)` строку в `docs/design/C_baselines.md §0` (cross-reference, чтобы C-doc упомянул что есть второй Mastra-based baseline).

---

## 1. Терминология

Локальные термины этого track'а. Переиспользуемые — см. `system_design §1`, `C_baselines §1`.

- **Mastra Agent** — `@mastra/core/agent` `Agent` class. Управляет internal multi-step loop'ом: model → tool_calls → execute → tool_results → model → ... до text-only response или step cap. Native поддержка `tools` (передаётся в constructor / generate options) и `memory` (через `Memory` instance).
- **`mastra-agent` baseline** — наш wrapper над `Agent` с зарегистрированными tools (per-bench: пустой для text-bench, 10 retail для tau). В отличие от `mastra_om`, который crank'ает `agent.generate()` без tools.
- **Tool translation** — приведение AI SDK v6 `tool({parameters: ZodSchema, execute: (input) => ...})` к Mastra tool format (precise shape determined в §4 investigation, ожидается похожий с `parameters` / `execute` callbacks).
- **Episode runner (Mastra variant)** — `mastra-agent-runner.ts` — копия по форме `tau-bench-retail/agent-runner.ts`, но actor `generateText` заменён на `agent.generate()` с registered tools, остальной alternation loop (user-sim ↔ actor) сохраняется.

---

## 2. Архитектура

### 2.1 Зачем ещё один Mastra-based baseline (помимо `mastra_om`)

`mastra_om` тестирует **только память**: `agent.generate([{role:'user', content: text}], {memory: {thread, resource}})` — single round-trip per `step()`, tools не передаются. На text-bench это нормально (LME/LoCoMo: 0 tools), на tau — не работает (нужны live retail tools).

`mastra-agent` тестирует **полный agentic loop**: тот же `Agent` + `Memory`, но с registered tools и multi-step generation. На text-bench почти не отличается от `mastra_om` (см. §2.2 — асимметрия); на tau — становится единственным framework-native competitor для `tau_bench_agent_ahc`.

**Что это изолирует** (per `feedback_eval_component_purpose`):
- **Failure mode**: «AHC ahc_full побеждает потому что у нас нет industry-standard agentic framework competitor на tool-heavy задачах». До I3 это правда — на tau стоит только `tau_bench_agent` vanilla (no compaction) + `tau_bench_agent_ahc`. Mastra Agent с tools — закрывает эту лакуну.
- **Irreducibility vs existing baselines**:
  - vs `mastra_om`: добавляет tools-aware step и multi-step loop.
  - vs `tau_bench_agent_ahc`: без AHC middleware; чистый Mastra framework.
  - vs `tau_bench_agent` vanilla: structurally разный agent loop (Mastra internal vs AI SDK ReAct).

### 2.2 Асимметрия по бенчам — честная оценка

| Bench | `mastra-agent` vs `mastra_om` ожидаемая разница | Value-add от прогона |
|---|---|---|
| `assistant-traj` | **Малая.** AT — replay benchmark, 24/30 task'ов `tools_available=[]`, 6/30 имеют 1 tool как декларация (не для live exec). Mastra Agent без активного tool dispatch ≈ `mastra_om` | Confirms consistency Mastra path; baseline для tau-сравнения tools-aware прогон |
| `lme-multiturn` | **Малая-средняя.** Session-per-turn replay, 0 tools. Отличается от `mastra_om` тем, что Agent может иметь multi-step internal loop, но при отсутствии tools это сводится к 1 step | То же — consistency check |
| `tau-bench-retail-med` | **Большая.** 10 live retail tools + 1 think + AHC recall (для `mastra-agent` без AHC — без recall). Mastra Agent выполняет multi-step React-style loop по своей логике | **Main deliverable** — единственный framework-native agentic competitor против `tau_bench_agent_ahc` |

Прогон по всем трём бенчам нужен для:
1. **Tau** — основной target.
2. **AT / LME-mt** — chassis consistency: показать что `mastra-agent` ≈ `mastra_om` на text-bench (если расходится — это значит регрессия в Mastra Agent path; нужно investigate).
3. **Audit-table parity** — F-report ожидает одну строку per baseline во всех benches таблицах.

### 2.3 Data flow

**Text-bench step (lme-multiturn / assistant-traj):**

```
user_msg
  │
  ▼
MastraAgentBaseline.step(state, user_msg)
  │
  ├─ lazy-init Agent + Memory (LibSQL per-task)
  │
  ├─ agent.generate(
  │     [{role:'user', content: extractText(user_msg)}],
  │     {memory: {thread, resource}, tools: <empty for text-bench>, modelSettings: {temperature: 0}}
  │   )
  │
  ├─ collect usage (input/output/cached tokens) → telemetry
  ├─ cost via costFromUsageWithCache (как в mastra_om)
  │
  ▼
{response, state (+history), telemetry, cost_usd}
```

**Tau episode (главный case):**

```
EnvState (cloned from episode.initial_state)
  │
  ▼
runTauEpisodeMastra(episode, deps)
  │
  ├─ Translate retailTools (AI SDK format) → mastraTools (Mastra format) — closures сохраняют ref на envState
  ├─ Build Agent: instructions=actorSystem, model=actorModel, memory=Memory(LibSQL), tools=mastraTools
  │
  ├─ while stepsUsed < maxSteps:
  │     ├─ userSimStep(messages, instruction)  ← unchanged from agent-runner.ts
  │     ├─ messages.push({role:'user', content: userText})
  │     │
  │     ├─ actorResult = agent.generate(
  │     │     messages,
  │     │     {memory:{thread,resource}, tools: mastraTools, modelSettings:{temperature:0}}
  │     │   )
  │     │   ← Mastra's internal multi-step loop: handles tool_calls + tool_results
  │     │     согласно своей логике (детали — §4 investigation)
  │     │
  │     ├─ messages.push(...actorResult.response.messages)
  │     ├─ accumulate cost/usage
  │     └─ check terminal text
  │
  ▼
EpisodeResult {reward = calculateReward(envState, expected_end_state), n_steps, ...}
```

### 2.4 Modules

| Module | Role | File | Track-phase |
|---|---|---|---|
| `MastraAgentBaseline` | Text-bench Baseline impl: prepare / step / finalize | `src/eval/baselines/mastra_agent.ts` | I1 |
| `aiSdkToolToMastra` | Translator AI SDK `tool({execute})` → Mastra tool | `src/eval/baselines/mastra_agent.ts` (или отдельный helper file) | I1 (text-bench не использует, но определяется здесь для I2) |
| `runTauEpisodeMastra` | Mirror `runTauEpisode` но через Mastra Agent | `src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts` | I2 |
| Runner registry entry | `baseline === 'mastra-agent'` dispatch | `src/eval/runner.ts` (расширение switch) | I1 (text-bench) + I2 (tau dispatch) |
| Sweep YAML | Запуск через `pnpm tsx scripts/eval.ts --sweep ...` | `eval/sweeps/main_e1_mastra_agent.yaml`, `eval/sweeps/smoke_mastra_agent.yaml` | I3 |
| Numbers per bench | Включая Mastra Memory disclaimer | `docs/runs/baselines_frozen.md` (Text benches + Tau-bench sections) | I3 |

### 2.5 Public types / contracts

```typescript
// src/eval/baselines/mastra_agent.ts

export type MastraAgentDeps = {
  apiKey: string                  // OpenRouter API key
  providerId?: string             // default 'openrouter'
  modelId?: string                // default 'openai/gpt-5.4-mini'
  url?: string                    // default 'https://openrouter.ai/api/v1'
  storageRootDir?: string         // default './.mastra'
  systemPrompt?: string           // default DEFAULT_AGENT_SYSTEM_PROMPT
  tools?: Record<string, MastraTool>  // pre-translated tools (опционально, для I1 text-bench пусто)
}

export function mastraAgentBaseline(deps: MastraAgentDeps): Baseline

// src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts

export type RunTauEpisodeMastraDeps = {
  actorModel: LanguageModelV3
  userSimModel: LanguageModelV3
  actorSystem: string
  actorModelId?: string
  userSimModelId?: string
  maxSteps?: number
  // НЕТ ahcFlags — `mastra-agent` исключает AHC по дизайну. AHC поверх Mastra —
  // отдельная история (вне scope Track I).
}

export async function runTauEpisodeMastra(
  episode: Episode,
  deps: RunTauEpisodeMastraDeps,
): Promise<EpisodeResult>  // тот же EpisodeResult что у runTauEpisode
```

---

## 3. `MastraAgentBaseline` (text-bench shape, I1)

### 3.1 Contract

`Baseline` interface из `src/eval/types.ts` — тот же что `mastra_om`. Differs только тем, что `tools` параметр поддерживается (для I1 пуст, но wiring готов к I2 reuse).

### 3.2 Pseudocode

```
prepare(task):
  storage_path = resolve(storageRoot, `c1_${safeTaskId}.db`)
  thread_id    = `mastra_agent_${safeTaskId}`
  resource_id  = `ahc_resource_${safeTaskId}`
  return {
    task_id,
    history: [],
    scratch: { thread_id, resource_id, storage_path, mastra_agent_config }
  }

step(state, user_msg, opts):
  agent = agents.get(scratch.storage_path) ?? buildAgent(deps, scratch.storage_path)
  user_text = extractText(user_msg)
  turn_index = history.filter(m=>m.role==='user').length

  result = agent.generate(
    [{role:'user', content: user_text}],
    { memory: { thread, resource }, tools: deps.tools ?? {}, modelSettings: { temperature: 0 } }
  )

  usage = await result.usage
  telemetry = composeTurnRecord({turn_index, input_tokens, output_tokens, cache_read_input_tokens, wall_clock_ms}, {})
  cost_usd = costFromUsageWithCache(modelId, reshape(usage))

  return {
    response: {role:'assistant', content:[{type:'text', text: result.text}]},
    state: {...state, history: [...history, user_msg, response]},
    telemetry,
    cost_usd
  }

finalize(state):
  cleanup(scratch.storage_path)  // rm LibSQL file
  agents.delete(scratch.storage_path)
```

### 3.3 BaselineState.scratch shape

```typescript
type MastraAgentScratch = {
  thread_id: string
  resource_id: string
  storage_path: string
  mastra_agent_config: {
    model: string                 // 'openrouter/openai/gpt-5.4-mini'
    provider_id: string           // 'openrouter'
    storage_kind: 'libsql'
    mastra_version: string        // e.g. '1.32.1' — matches packaged version
    tools_registered: string[]    // names of tools registered (для tau — 10+1, для text — [])
  }
}
```

### 3.4 Failure modes / fallbacks

| Mode | Detection | Fallback |
|---|---|---|
| Mastra silently falls back to `google/gemini-2.5-flash` для OM (без `observationalMemory.model`) | OM не fires, OPENROUTER_API_KEY не используется | `buildMemoryOptions` явно передаёт `observationalMemory.model` — копируется из `mastra_om.ts:103-111` |
| Cost bubble обратно `0` (как было до commit `5777796` для `mastra_om`) | `cost_usd === 0` хотя `usage.inputTokens > 0` | Verify в I1 что `costFromUsageWithCache` возвращает > 0 на первом live LME task; иначе investigate Mastra usage shape evolution |
| Mastra Agent падает на tool execution (если tools переданы но Mastra их не принимает) | Exception during `agent.generate()` | I2 investigation определит точный API; if tool API differs structurally — adapter в §4 |
| LibSQL file lock collision между concurrent task'ами | `LIBSQL: database is locked` error | Per-task SQLite file как в `mastra_om` (storage_path keyed by safeTaskId) — collision не возможна |

---

## 4. Tau-bench Mastra adapter (I2)

### 4.1 Step 0 investigation (~2 часа)

**Перед кодингом I2:** investigation `docs/investigations/mastra-tools-api.md` отвечает на:

1. **Tool definition shape.** Mastra `tool()` (если есть в `@mastra/core`) или передача raw object'а — что принимает `Agent({tools: ...})` или `agent.generate({tools: ...})`? Какой формат `parameters` (Zod / JSON schema / raw object)? Какие callbacks (`execute(input, ctx)` — какой `ctx`)?
2. **Tool execution timing.** Mastra сам разрешает tool calls внутри `agent.generate()` (как AI SDK), или нужно явно loop'ить и подавать tool_results обратно?
3. **Step cap.** Есть ли эквивалент `stopWhen: stepCountIs(N)`? Если нет — как ограничить?
4. **Tool error propagation.** Если `execute()` throws — отправит ли Mastra tool_result с ошибкой обратно модели (как AI SDK)?
5. **Cost bubbling on tool calls.** Считается ли cost всех internal LLM calls в одном `result.usage`, или нужно вручную аккумулировать?

Investigation closes с конкретным API decision'ом + примером кода `agent.generate(messages, {tools: ..., modelSettings: ...})` с реальным execute callback'ом.

### 4.2 Contract

```typescript
// Same signature shape as runTauEpisode, минус ahcFlags
export async function runTauEpisodeMastra(
  episode: Episode,
  deps: RunTauEpisodeMastraDeps,
): Promise<EpisodeResult>
```

`EpisodeResult` тот же что у `runTauEpisode` — гарантирует совместимость с upstream `tau-bench-retail/index.ts` grader + sweep machinery.

### 4.3 Tool translation

```typescript
// AI SDK v6 tool (текущий формат в tau-bench-retail/tools.ts)
const cancelPendingOrder = tool({
  description: 'Cancel a pending order ...',
  parameters: z.object({ order_id: z.string(), reason: z.string() }),
  execute: async ({ order_id, reason }) => { /* mutate envState */; return { success: true } },
})

// Mastra tool (формат финализируется в §4.1 investigation; гипотетический)
const cancelPendingOrderMastra = createMastraTool({
  id: 'cancel_pending_order',
  description: 'Cancel a pending order ...',
  inputSchema: z.object({ order_id: z.string(), reason: z.string() }),
  execute: async ({ context: { order_id, reason } }) => { /* same envState closure */ ... },
})

// Translator:
function aiSdkToolToMastra(name: string, tool: AISdkTool): MastraTool {
  return createMastraTool({
    id: name,
    description: tool.description,
    inputSchema: tool.parameters,
    execute: async ({ context }) => tool.execute(context),
  })
}
```

**Critical**: closures над `envState` сохраняются — Mastra execute callback получает тот же input shape и вызывает тот же execute function что AI SDK, env mutates in-place.

### 4.4 Failure modes

| Mode | Detection | Fallback |
|---|---|---|
| Mastra не parsит tool_call output модели правильно (если модель эмитит другой JSON shape) | `agent.generate()` возвращает text вместо tool_call, или ошибка parsing | Investigation в §4.1 закрывает; smoke I2 не пройдёт если broken |
| Step cap не работает → infinite loop | wall_clock > 5 min на 1 episode | `setTimeout(reject, 5*60*1000)` обёртка вокруг `runTauEpisodeMastra` + `maxSteps` параметр который проверяем после каждого step'а |
| Cost не bubble'ится на tool-heavy episode | `cost_usd < expected` (compare против manual price × tokens) | Verify в I2 smoke на 1 episode — если broken, manual cost computation (`costFromUsage` over accumulated tokens) |
| User-sim integration ломается (Mastra ожидает messages в другом shape) | Type error / unexpected response shape from `agent.generate(messages, ...)` | Adapter в §4.3 normalize messages к Mastra format (если требуется ModelMessage→Mastra-message transform) |

---

## 5. Sweep YAMLs (I3)

### `eval/sweeps/main_e1_mastra_agent.yaml`

```yaml
name: main_e1_mastra_agent
# Track I sweep — mastra-agent baseline across 3 mt-style benches.
# Used for cross-framework comparison vs AHC-based competitors.

benches:
  - assistant-traj
  - lme-multiturn
  - tau-bench-retail-med

configs:
  - id: mastra-agent
    baseline: mastra-agent

seeds: [42]
budget_usd: 30  # tau dominates: ~$0.5-0.7/episode × 30 episodes = $15-21; text benches ~$1-3 каждый
```

### `eval/sweeps/smoke_mastra_agent.yaml`

```yaml
name: smoke_mastra_agent
# Track I smoke — 1 task per bench, end-to-end pipeline check.
# Acceptance gate I3: status=complete для всех 3 cells.

benches:
  - assistant-traj
  - lme-multiturn
  - tau-bench-retail-med

configs:
  - id: mastra-agent
    baseline: mastra-agent

seeds: [42]
budget_usd: 5
# Используется с --max-tasks-per-cell=1
```

Запуск:
```bash
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_mastra_agent.yaml \
  --max-tasks-per-cell=1 --concurrency=1
```

### Budget breakdown

| Cell | n | est. cost/task | total |
|---|---|---|---|
| `assistant-traj × mastra-agent` (n=20, seed=42) | 20 | $0.005-0.01 | ~$0.20 |
| `lme-multiturn × mastra-agent` (n=10, seed=42) | 10 | $0.50-1.00 | ~$5-10 |
| `tau-bench-retail-med × mastra-agent` (n=30, seed=42) | 30 | $0.50-0.70 | ~$15-21 |

Total: **~$20-31** для main sweep. Smoke: **~$2-3**.

---

## 6. Acceptance / freeze rules

### 6.1 I3 acceptance

- `status=complete` на всех 3 cells (`sanity-aggregate` показывает).
- `err_rate=0%` на 3 cells (allows проверить что pipeline не падает на real data).
- Tau cell: **≥ 50% episodes имеют ≥ 1 tool call** (отслеживается через `n_tool_calls` field в EpisodeResult, summary aggregation).
- Audit-doc `i_mastra_agent_audit.md` создан, числа per bench:
  - `n / input_tok / cache% / acc / total_$` для каждого из 3 benches.
  - Сравнение vs `mastra_om` (text-bench) — должна быть delta < 5pp на acc (chassis consistency).
  - Сравнение vs `tau_bench_agent_ahc` (tau) — основной insight.

### 6.2 Freeze в `baselines_frozen.md`

`mastra-agent` числа уходят в frozen-таблицу когда:
- Acceptance §6.1 пройден.
- Mastra package version пиннута в `package.json` (не floating major).
- Tool translation в `aiSdkToolToMastra` не менялся между двумя последовательными прогонами (re-run consistency check).

Re-freeze trigger: bump Mastra version, изменение tool API, или изменение translator.

### 6.3 Что НЕ acceptance criterion

- **`mastra-agent` accuracy не обязана быть выше `mastra_om`** на text-bench — если ниже, это валидное чтение «framework Agent loop добавляет шум на zero-tools tasks», документируем и идём дальше.
- **`mastra-agent` accuracy на tau не обязана быть выше `tau_bench_agent_ahc` или vanilla** — нулевой результат тоже informative (сейчас все 3 baselines на tau дают 0.100 — это capability ceiling gpt-5.4-mini, не алгоритм).

---

## 7. Инварианты

### 7.1 Per-task storage isolation

Каждый task получает свой SQLite-файл `./.mastra/c1_mastra_agent_<task_id>.db`; thread_id внутри Mastra Memory keyed по task_id. **Тестируется** unit-тестом: два concurrent step'а на разных task_id не лочатся (через file paths).

### 7.2 Fair-comparison invariant: same system prompt across baselines

`mastra-agent` использует `DEFAULT_AGENT_SYSTEM_PROMPT` (тот же что `mastra_om`, `full_context`, `ahc_full`, `anthropic_compact`). На tau — тот же actor system prompt что у `tau_bench_agent` / `tau_bench_agent_ahc` (formed по `buildSystemPrompt({benchContext: wiki.md, tools: [...]})`). **Тестируется** integration: smoke прогон сравнивает system prompt'ы через snapshot.

### 7.3 Env state ownership

На tau env state живёт в closures retail tools (как у AI SDK варианта). После episode env state read'ится через `calculateReward(envState, expected_end_state)`. Mastra НЕ владеет env state — она только вызывает execute callbacks. **Тестируется**: после smoke tau episode `envState !== episode.initial_state` если actor сделал ≥1 mutating tool call.

### 7.4 Cost bubbling

`cost_usd` в RunRecord не нулевой когда были usage tokens (исключает регрессию `mastra_om` pre-`5777796`). **Тестируется**: live smoke на 1 lme-mt task проверяет `cost_usd > 0`.

### 7.5 No AHC contamination

`mastra-agent` baseline **не** оборачивает actor model в `wrapLanguageModel({middleware: createAhcMiddleware})`. Это competitor, а не AHC-вариант. **Тестируется**: smoke прогон проверяет в telemetry что compaction_events пустые (AHC не fires потому что middleware не зарегистрирован).

---

## 8. Open questions

- **Mastra tool API actual shape** — финализируется в §4.1 investigation перед I2. Если API радикально отличается от AI SDK (например, требует Mastra-нативные tool factory'и а не plain object'ы) — добавится step "wrap tau-bench-retail/tools.ts in Mastra-shaped factories" в I2.
- **Mastra Memory с long histories (40+ turns на lme-multiturn)** — Memory автоматически compactит или хранит всю историю verbatim? Если автокомпактит, наш `mastra-agent` НЕ pure non-compaction baseline на lme-mt — нужно отметить в audit. Investigation в I1 закрывает: smoke на 1 lme-mt task → check token usage trajectory across turns.
- **Cross-model сравнение** (Sonnet/Gemini вместо gpt-5.4-mini) — deferred. Если F-report потребует — добавить как отдельную фазу I4 (зеркалит H1 cross-model для AHC).
- **`mastra-agent` + AHC композиция** — out of scope Track I (AHC поверх Mastra). Если interesting — заводить отдельный Track J.
- **Что делать если smoke I2 показывает infinite loop / step cap проблему** — investigation §4.1 закрывает; fallback в §4.4.
