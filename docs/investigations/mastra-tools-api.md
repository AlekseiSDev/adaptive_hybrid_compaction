# Investigation: Mastra Agent tools API (Track I2 prereq)

## Meta

- **Date Created:** 2026-05-22
- **Date Updated:** 2026-05-22
- **Status:** Completed
- **Related:** `docs/design/I_mastra_agent.md §4.1`, `docs/design/I_mastra_agent.md §4.3` (speculated translator), `src/eval/adapters/tau-bench-retail/tools.ts` (10 AI SDK retail tools), `src/eval/adapters/tau-bench-retail/agent-runner.ts` (AI SDK runner template)

## Goal

Перед стартом I2 (tau-bench Mastra adapter) — закрыть 5 open questions из
`I_mastra_agent.md §4.1`: tool shape, execution timing, step cap, error
propagation, cost bubbling. Outcome: concrete API decision + 5-line example,
обновлённый scope I2 sub-steps (если радикально отличается).

## Problem Statement

- Дизайн `I_mastra_agent.md §4.3` спекулирует translator
  `aiSdkToolToMastra(name, tool) → createMastraTool({id, description,
  inputSchema, execute: async ({context}) => tool.execute(context)})`. Не
  верифицировано — Mastra может принимать AI SDK shape напрямую.
- Тулы tau-bench retail (`src/eval/adapters/tau-bench-retail/tools.ts:163-296`,
  10 штук) определены через `tool({description, inputSchema: jsonSchema(...),
  execute})` из `ai` package — это AI SDK v6 `ToolV5` shape.
- Если Mastra принимает их native — translator не нужен, code path
  упрощается до прямого forwarding. Если требует обёртки — нужна
  helper-функция + unit tests.
- Также неясно: где tools attach (Agent constructor vs `agent.generate()`
  options), как ограничить шаги, как протекает cost.

## Scope

- **In scope:** API shape для tool registration в `@mastra/core@1.32.1`;
  generate() options для tools + step cap; runtime behavior tool errors;
  cost.usage aggregation across multi-step.
- **Out of scope:** Mastra Workflows / Steps API (alternative orchestration);
  cross-model behavior; tool approval flows.
- **Constraints:** no live spend для investigation (туда же сразу пойдёт I2 unit + smoke).

## Hypotheses

| ID | Hypothesis | Why plausible | How to validate | Status |
|---|---|---|---|---|
| H1 | Mastra принимает AI SDK `ToolV5` объекты напрямую (без translator) | Mastra wraps AI SDK; уже принимает AI SDK message format | Inspect type `ToolsInput` в `@mastra/core/dist/agent/types.d.ts` | **confirmed** |
| H2 | Tools регистрируются через Agent constructor `new Agent({tools})` | Симметрично mastra_om (instructions + model + memory в constructor) | Inspect `AgentConfig.tools` type | **confirmed** |
| H3 | `agent.generate(messages, {maxSteps})` ограничивает loop (эквивалент AI SDK `stopWhen: stepCountIs(N)`) | AI SDK roots; common pattern | Inspect `AgentExecutionOptionsBase.maxSteps` | **confirmed** |
| H4 | `result.usage` aggregates tokens across all internal LLM calls в multi-step loop | AI SDK v6 same behavior | Live probe: 1 retail episode + log per-step usage | **deferred** (verified in I2 live smoke directly) |
| H5 | Tool execute() exceptions propagate as tool_result errors back to model | AI SDK default behavior; Mastra builds on top | Live probe в I2 smoke (forced exception) | **deferred** (acceptable risk; falling back to manual handling если нужно) |

## Evidence

### Type-level inspection (`@mastra/core@1.32.1`)

**`ToolsInput` definition** (`node_modules/@mastra/core/dist/agent/types.d.ts:45`):

```typescript
export type ToolsInput = Record<
  string,
  ToolAction<any, any, any, any, any> | VercelTool | VercelToolV5 | ProviderDefinedTool
>
```

`VercelToolV5` — это AI SDK v5/v6 `ToolV5` (`node_modules/@mastra/core/dist/tools/types.d.ts:18`):

```typescript
export type VercelTool = Tool
export type VercelToolV5 = ToolV5
```

`ToolV5` (`_types/@internal_external-types/dist/index.d.ts:734`) — точно та форма,
которую produces AI SDK `tool({description, inputSchema, execute})`:

```typescript
export declare type ToolV5<INPUT, OUTPUT> = {
    description?: string
    inputSchema: FlexibleSchema<INPUT>
    // ... onInputStart / onInputDelta / onInputAvailable (optional)
    execute?: (input, options) => Promise<OUTPUT>
    // ...
}
```

→ **H1 confirmed.** AI SDK tools — valid `ToolsInput` values.

**`AgentConfig.tools` field** (`agent/types.d.ts:227`):

```typescript
tools?: DynamicArgument<TTools, TRequestContext>
```

→ **H2 confirmed.** Tools register через Agent constructor (DynamicArgument
supports plain `ToolsInput` объекта).

**`AgentExecutionOptionsBase.maxSteps`** (`agent/types.d.ts:403`):

```typescript
/** Maximum number of steps allowed for generation */
maxSteps?: number
```

→ **H3 confirmed.** `agent.generate(messages, {maxSteps: N})` ограничивает loop.

### Createtool factory (not needed для I2)

`createTool({id, description, inputSchema, execute})` существует
(`tools/tool.d.ts:261`) — это canonical Mastra способ. Но он необязательным
оказывается для I2: AI SDK `tool({...})` объекты accept'ятся напрямую.
Используем `createTool` если позже захотим нативно-Mastra инструменты.

## Findings

| Source | Result | Confidence | Notes |
|---|---|---|---|
| `agent/types.d.ts:45` (`ToolsInput`) | Mastra accepts AI SDK `ToolV5` directly | high | Type-level guarantee; no runtime adapter required |
| `agent/types.d.ts:227` (`AgentConfig.tools`) | Tools register в Agent constructor | high | Сравнимо с mastra_om instructions/memory wiring |
| `agent/types.d.ts:403` (`maxSteps?`) | Step cap available на generate() | high | Direct equivalent of AI SDK `stopWhen: stepCountIs(N)` |
| Live retail episode (deferred to I2 smoke) | `result.usage` aggregates multi-step | med | AI SDK v6 behavior; Mastra likely passes through |
| Live retail episode (deferred to I2 smoke) | Exceptions surface as tool errors | med | Same expected behavior; will catch in smoke если broken |

## Interpretation

**Translator NOT needed для I2.** `aiSdkToolToMastra` spec'ed в design §4.3 —
artefact of cautious pre-investigation. Реальный API проще: pass
`retailTools(envState)` (existing AI SDK Record) прямо в Agent constructor
field `tools`. Это упрощает I2 scope:

- Никакой `aiSdkToolToMastra` helper.
- Никаких unit-тестов на translation (translator не существует).
- Closures over `envState` сохраняются прямо в native execute callbacks —
  без двойной обёртки.

**Step cap** — `maxSteps` option на `agent.generate()`; default behavior
(unbounded) защищаем wall-clock timeout (5min) per-episode safety net.

**Cost & errors** — verify в I2 live smoke; если broken — adjust runner, но
не expected (Mastra wraps AI SDK semantics).

## Next Actions

- **Action:** I2 sub-steps без translator:
  1. `runTauEpisodeMastra(episode, deps)` в
     `src/eval/adapters/tau-bench-retail/mastra-agent-runner.ts` — mirror
     `runTauEpisode` shape, actor build = `new Agent({instructions, model,
     memory, tools: retailTools(envState)})`, call
     `agent.generate(messages, {memory, maxSteps: remainingSteps})`.
  2. Tau-bench retail tools forwarded as-is (no wrapping).
  3. Runner dispatch: extend `makeTauBenchAgentRunner` или ввести
     `makeTauBenchMastraAgentRunner` (cleaner separation, не путаем
     vanilla/AHC dispatch).
- **Verification:** I2 unit tests на runner shape + live smoke 1 retail
  episode — должен иметь `n_tool_calls ≥ 1` + `envState !== initial_state`.
  H4/H5 falsify в smoke directly.
- **Decision entry:** не tянет на `decisions.md` — implementation routine per
  `feedback_decisions_threshold`. Investigation doc — каноническое место.
- **Harness entry:** none.

## Implementation reference snippet

```typescript
import { Agent } from '@mastra/core/agent'
import { retailTools } from './tools.js'

const envState = cloneEnvState(episode.initial_state)
const agent = new Agent({
  id: 'ahc_mastra_agent_tau',
  name: 'AHC Mastra Agent (tau-bench retail)',
  instructions: deps.actorSystem,
  model: { providerId: 'openrouter', modelId: deps.actorModelId, url: '...', apiKey: '...' },
  memory: new Memory({ storage, options: { observationalMemory: { model } } }),
  tools: retailTools(envState),  // AI SDK Record<string, Tool> — accepted directly
})

const result = await agent.generate(messagesAsAiSdkFormat, {
  memory: { thread, resource },
  maxSteps: remainingSteps,
  modelSettings: { temperature: 0 },
})
// envState уже мутировал через tool closures
// result.usage — aggregate across all internal LLM calls
```
