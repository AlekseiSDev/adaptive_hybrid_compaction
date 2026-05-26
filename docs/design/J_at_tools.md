# Track J — AssistantTraj Tool-Grounded Corpus (v2)

Документ описывает следующую итерацию AssistantTraj benchmark: переход с **text-only
corpus (AT-v1, 30 tasks)** на **tool-grounded corpus (AT-v2, 50 tasks)** с
обязательным ≥1 tool-call per task, замоканной toolset из 4 функций
(`image_gen`, `google_search`, `web_fetch`, `code_interpreter`), и fixture-replay
runtime'ом для детерминированного A/B compaction.

Источник идеи и большая часть seed-материала — jay-canvas e2e golden-set
(`/Users/Aleksei/Projects/jay-canvas/apps/platform/api/e2e/golden-set/`). Источник
имплементаций тулов (на live-режим) — тот же репозиторий (`apps/platform/api/src/functions/`).

Системные цели, scope, eval-protocol и phase plan — см. `system_design.md`. Эта
инициатива дополняет Track D, не заменяет его дизайн: schema (`§2`),
storage layout (`§7`), judge cache (`§6.2`) — переиспользуются; **расширяется**
runtime tool-dispatch и framing в Track D `§9` (compaction axis table).

> **Prereq (Track J Step 0).** В `system_design.md §7.1`/`§7.2` добавляется Track J
> scope row + phase schedule одной правкой в этом же PR — иначе design doc висит
> в воздухе (см. CLAUDE.md `Phase-intro doc update in same plan`). Также один-line
> patch в Track D `§9` (compaction axis table) — see §9 ниже.

---

## Meta

- **Initiative:** Track J (J1 schema-patch → J2 tool adapters → J3 corpus port →
  J4 corpus top-up → J5 grader update → J6 sweep cutover + AT-v1 retire)
- **Wall-clock:** 8 дней (J1: 1d, J2: 2d, J3: 1.5d, J4: 1d, J5: 1d, J6: 1.5d)
- **Бюджет:** ≤$5 API на повторный E1 smoke против AT-v2 (judge cache переиспользуется
  частично — новые `task_id`, новые keys). Live-tool dev — $0 (по умолчанию replay).
- **Зависит от:** Track D полностью закрыт (`§2` schema, `§7` layout, `§6` judge
  cache — всё переиспользуется); B5 (mastra-agent baseline) — не блочит, но AT-v2
  должен поднять mastra_agent тем же tool set'ом.
- **Блокирует:** перевод E1 / H follow-up sweeps на AT-v2 (одна правка sweep YAML);
  F-report Discussion'у про "AT trajectory-coherence axis" нужны цифры из J6.
- **Артефакт:** обновлённый `benchmarks/assistant_traj/tasks/` (50 файлов, AT-v1 удалён),
  `src/eval/adapters/assistant-traj.tools.ts` (4 tool impls + replay/live dispatch),
  AT-v2 per-baseline numbers лягут прямо в `docs/runs/baselines_frozen.md`
  Text benches section с пометкой "AT-v2" (J6 follow-up sweep — не отдельный doc).
- **Owner:** Aleksei (corpus review + sign-off); agent (импорт jay-canvas, tool
  стабы, schema patch, grader update).
- **Связь:** `system_design §6.3` (AT framing), `system_design §7.2 Track D`
  (phase parent), `design/D_assistant-traj.md` (schema + judge, source of truth),
  `decisions.md [2026-05-13] D4 replay-only` (сохраняется — replay теперь
  включает tool outputs), `docs/runs/baselines_frozen.md` (получает note про
  AT-v1 retire), jay-canvas `apps/platform/api/e2e/golden-set/`,
  jay-canvas `apps/platform/api/src/functions/` (live-tool source).

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Per-phase —
> exit signal для агента-реализатора, симметричный TDD seed на входе.

### Track J (после J6) — AT-v2 closed

**Доступно:**
- `benchmarks/assistant_traj/tasks/*.json` — ровно 50 задач, каждая с **non-empty
  `tools_available[]`** и **≥1 `expected_tool_calls[]` entry с `required:true`**.
  AT-v1 30 задач удалены; git history их сохраняет.
- `benchmarks/assistant_traj/tool_fixtures/<task_id>.json` — replay фикстуры
  (см. §3.2). Каждая запись — `{tool_name, input_match, output_parts[]}`.
- `src/eval/adapters/assistant-traj.tools.ts` — 4 tool definitions + dispatcher:
  `image_gen`, `google_search`, `web_fetch`, `code_interpreter`. Default mode = `replay`.
  Live mode (`AT_TOOL_MODE=live`) — wired к Brave / OpenAI Images / fetch+readability / pyodide.
- `src/eval/adapters/assistant-traj.ts` — `prepare()` теперь возвращает
  `{messages, tools}`; baseline wires `tools` в `generateText({tools})`. Adapter
  surface для других бенчей не меняется (Conversation `tools?` optional).
- Grader проверяет **tool-call coherence**: per task все `required:true` tools
  должны быть вызваны хотя бы раз; `args_match` enforced per
  `ToolCallExpectation` (см. §6).
- Sweep YAML `eval/sweeps/main_e1_text_lme_mt_n50_assistant_traj_v2.yaml` —
  готов к E1 re-run; AT-v2 row в sweep matrix.
- `docs/runs/baselines_frozen.md` получает entry: "AT-v1 numbers (n=30, text-only)
  superseded 2026-05-22; AT-v2 (n=50, tool-grounded) — see `at_v2_baselines.md`."

**Demo (e2e):** `pnpm tsx benchmarks/assistant_traj/validate.ts && pnpm tsx
scripts/run-baseline.ts --bench assistant_traj --baseline full_context --n 3`
— validator зелёный на всех 50 task'ах; smoke прогоняет 3 task через
`full_context` baseline с replay-tools, печатает per-task tool-call summary
(`called=[image_gen, google_search]; required=[image_gen]; pass=true`).

**Acceptance gate:** `./scripts/verify.sh` зелёный + (a) `validate.ts` 50/50
schema pass + (b) каждая task имеет ≥1 `required:true` tool в `expected_tool_calls`
(grep check) + (c) sweep YAML smoke (1 task per baseline) зелёный через
`runSweep`-путь.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **J1** | Schema patched: `tools_available` обязан быть non-empty (length≥1) когда `expected_tool_calls` непустой; новый optional `tool_fixtures_ref?: string` указатель на sidecar fixture file; `ToolDefinition.input_schema` обязан быть JSON-Schema-shape (validator проверяет `{type, properties, required?}` минимум). | `pnpm exec vitest run src/eval/adapters/assistant-traj.schema.test.ts` (новые тесты в Red должны fall'ить, зелёные после J1 Green) |
| **J2** | `src/eval/adapters/assistant-traj.tools.ts` — 4 tool defs (AI SDK v6 `tool()` shape) + replay dispatcher (default) + live dispatcher (gated `AT_TOOL_MODE=live`). Replay читает sidecar `tool_fixtures/<task_id>.json`. Live: `image_gen`→OpenAI Images API, `google_search`→Brave (как в jay-canvas), `web_fetch`→fetch+`@mozilla/readability`, `code_interpreter`→`pyodide`. | `pnpm exec vitest run src/eval/adapters/assistant-traj.tools.test.ts` — round-trip: replay вызов → cached output; live вызов мокается через msw на network layer |
| **J3** | ~30 jay-canvas-seeded tool-grounded задач в `tasks/` + `tool_fixtures/`. AT-v1 30 текстовых задач удалены одним коммитом (`git rm`). Hand-extension до 5–15 turns где jay-canvas даёт 1–2. Categories rebalanced (§5.1). | `pnpm tsx benchmarks/assistant_traj/validate.ts` — schema green over ~30 conformant tasks + tool-fixtures pair'ы существуют |
| **J4** | Synthetic top-up до 50, если J3 даёт <50. Synthetic = `source:'synthetic'` + `provenance.review_signoff` non-empty (D §3.3 100% manual review gate). | `pnpm tsx benchmarks/assistant_traj/validate.ts` (schema green) + grep `"source":"synthetic"` cross-ref'нут с non-empty `review_signoff` |
| **J5** | Grader проверяет `expected_tool_calls` (required-presence + args_match per task; nested-aware для composite eval); `assistantTrajGrader` extended с tool-coherence score → score.tool_coherence (новое поле в Score?). Unit test: response с missing required tool → primary downgrades. | `pnpm exec vitest run src/eval/adapters/assistant-traj.grader-tools.test.ts` |
| **J6** | Sweep YAML cutover: `main_e1_*` правится на AT-v2; smoke 1×AT-v2 task per baseline зелёный; `baselines_frozen.md` получает retire-note; `at_v2_baselines.md` создан с свежим snapshot per baseline. | `pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_*.yaml --task-limit 1 --bench assistant_traj` (exit 0; RunRecord with `score.primary` non-null для каждой baseline) |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track J`
(добавляется этим PR).

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **J1** Schema patch | — | J2, J3, J5 | §2.1, §2.4 | `AssistantTrajTaskSchema` (расширение `tools_available` requirement), `tool_fixtures_ref?` | failing schema test: task с непустым `expected_tool_calls` но пустым `tools_available` — reject; missing `input_schema` shape — reject | §6 grader (cross-field rule между `tools_available` и `expected_tool_calls`) |
| **J2** Tool adapter layer | J1 | J3 (нужны tool defs для seed conversion), J5 (нужен replay для adapter prepare) | §3, §4 | `ToolReplayDispatcher`, `ToolLiveDispatcher`, `ToolFixtureFileSchema` | failing test: replay dispatch для `google_search({q:"x"})` без fixture entry → throws с понятным message; with fixture → returns cached `tool_result.content[]` | §5 corpus (через какие тулы каждая category дёрнет) |
| **J3** Corpus port + AT-v1 retire | J1, J2 | J4 (top-up gauge), J6 | §5, §5.1 | conformance к patched schema; AT-v1 файлы удалены одним коммитом | validator green на ≥30 jay-canvas-seeded; AT-v1 файлы physically отсутствуют в `tasks/` | §3 tool defs (импорт-маппинг jay-canvas tool names → наши 4), §7 storage |
| **J4** Synthetic top-up | J3 | J5 | §5.2 | `source:'synthetic'` tasks с full `tool_fixtures` + signoff | failing pre-flight: synthetic task без `review_signoff` или без paired fixture → fail validator | §5.1 target distribution (что недобрано) |
| **J5** Grader tool-coherence | J1, J3 (или J4 — нужен corpus) | J6 | §6 | `tool_coherence` поле в `Score` (cross-bench compat обсуждается — see §10); `evaluateToolCalls()` helper | failing grader test: response с правильным final answer но без required tool-call → primary=0 (или downgrade по §6.2) | `src/eval/types.ts` Score shape (если расширяется), `D §6.2` judge cache (новый key включает tool-call signature?) |
| **J6** Sweep cutover + retire | J5 | E1 re-run (отдельный PR), F-report numbers | §8 | `eval/sweeps/main_e1_*.yaml` правка; AT-v2 rows + retire note inline в `docs/runs/baselines_frozen.md` | failing: `runSweep` против AT-v2 sweep YAML без J5 — какие-то tasks score=0 на full_context (т.к. required tool not called в text-only chain) ⇒ AT-v2 действительно проверяет другую axis | E (main runs), H (follow-up sweeps), `baselines_frozen.md`, `current.md` Track J |

**Parallelization:** J1 — first, no deps. J2 параллелится с J3 после J1 (J2 = tool runtime; J3 = JSON files; не пересекаются по файлам). J4 ждёт J3 (надо знать сколько недобрали). J5 ждёт J3 (corpus для grader test) и J2 (replay dispatch для prepare()). J6 — last, depends on J5.

**Orthogonal / deferred:**
- **Live tool mode (полноценный)** — J2 ships *minimal* live impls достаточные для
  manual debug / capture новых фикстур. Production-grade live (cache, rate limit,
  retry, secret management через .env) — deferred к follow-up PR; не блочит J6
  cutover (default = replay).
- **`tool_coherence` как cross-bench metric** — J5 добавляет поле в Score только
  для AT; включение в general aggregator (P5 audit / cross-bench plots) — отдельный
  micro-PR в Track F prep. См. open question Q3 в §11.
- **Tool-args semantic match (`args_match: 'semantic'`)** — schema поддерживает,
  но J5 имплементит только `exact` и `subset`; `semantic` (LLM-judge на args)
  откладывается, не блочит acceptance gate (нет task'ов с этим режимом в J3/J4).

---

## 1. Терминология

Переиспользуем `system_design §1.1` и `design/D_assistant-traj.md §1`. Уникальное для J:

- **Tool fixture** — sidecar JSON в `benchmarks/assistant_traj/tool_fixtures/<task_id>.json`,
  содержащий упорядоченный список `{tool_name, input_match, output_parts[]}`. Replay
  dispatcher dispatch'ит вызов агента по `tool_name` + `input_match` policy.
- **Input match policy** — как matcher из фикстуры подбирает запись под live tool-call
  агента: `first` (любой вызов с этим именем тула — берёт следующую неиспользованную
  запись по порядку) / `args_subset` (input агента — superset фикстурного `args`) /
  `args_exact`. Default — `first` (порядковая последовательность).
- **Tool-call coherence** — boolean per-task метрика: все `required:true` записи в
  `expected_tool_calls` действительно вызваны хотя бы раз в трассе агента.
  Подмножество eval-grader'а (см. §6).
- **AT-v1 / AT-v2** — версии корпуса. v1 = текущие 30 text-only tasks (retired в J6).
  v2 = 50 tool-grounded (этот документ).
- **Replay mode** / **Live mode** — runtime tool-dispatch strategy (см. §4).

---

## 2. Архитектура

### 2.1 Task shape (delta к D §2)

```typescript
type AssistantTrajTask = {
  task_id: string
  category: 'image_qa' | 'code_iter' | 'research_write' | 'mixed'
  source: 'real' | 'opensource' | 'synthetic'

  turns: TaskTurn[]
  tools_available: ToolDefinition[]      // J1: length ≥ 1 enforced when expected_tool_calls non-empty

  evaluation: EvaluationSpec
  provenance: Provenance

  // NEW in J:
  tool_fixtures_ref?: string             // path relative to repo root, e.g.
                                         // "benchmarks/assistant_traj/tool_fixtures/at_mixed_001.json"
                                         // optional; absent ⇒ fixture file colocated by task_id default lookup.
}

// NEW in J — separate sidecar file shape:
type ToolFixtureFile = {
  task_id: string                        // must equal owning task's task_id (cross-field check)
  fixtures: ToolFixture[]
}

type ToolFixture = {
  tool_name: 'image_gen' | 'google_search' | 'web_fetch' | 'code_interpreter'
  input_match?:
    | { kind: 'first' }                  // default — next unconsumed entry for this tool_name
    | { kind: 'args_subset'; args: Record<string, unknown> }
    | { kind: 'args_exact'; args: Record<string, unknown> }
  output_parts: ContentPart[]            // tool_result content (reuses D §2 ContentPart)
  is_error?: boolean
}
```

**Why sidecar, not inline:** tool outputs могут быть жирными (web_fetch markdown
~5–20 KB, code_interpreter stdout до 100 KB). Inline раздует task JSON, мешает
diff-обзору turn-логики при review. Sidecar = diff-friendly review.

### 2.2 Data flow per task run

```
[load task] → AssistantTrajTaskSchema parse
            → загружаем sidecar tool_fixtures (если есть required tool calls)
            → adapter.prepare(task) returns { messages: user-only, tools: Record<name, AiSdkTool> }
            → baseline.runner.generate(messages, {tools})
                  ↳ agent loop (AI SDK v6 / Mastra / Anthropic native — depends on baseline)
                  ↳ per tool-call: ToolReplayDispatcher.handle({name, input, callCount})
                                     ↳ matcher finds ToolFixture entry → returns output_parts
                                     ↳ no match → error (deterministic failure surface)
            → final assistant response.text + collected toolCalls[]
            → grader.score(task, { text, toolCalls })
                  ↳ evaluateSpec(...) — D §5 unchanged
                  ↳ NEW: evaluateToolCalls(task.expected_tool_calls, response.toolCalls) — §6
                  ↳ aggregate primary
```

### 2.3 Modules

| Module | Role | File | Track-phase |
|---|---|---|---|
| AT task schema (patched) | Strict on-disk validation incl. tools/fixtures cross-field | `src/eval/adapters/assistant-traj.schema.ts` | J1 |
| Tool fixture schema | Sidecar JSON validation | `src/eval/adapters/assistant-traj.tool-fixtures.schema.ts` (new) | J1 |
| Tool definitions | 4 tools as AI SDK v6 `tool()` objects (name, input_schema, execute) | `src/eval/adapters/assistant-traj.tools.ts` (new) | J2 |
| Replay dispatcher | In-memory state per task run; matcher; deterministic miss = throw | `src/eval/adapters/assistant-traj.tools.ts` (same file) | J2 |
| Live dispatcher | Brave / OpenAI Images / fetch+readability / pyodide | `src/eval/adapters/assistant-traj.tools-live.ts` (new) | J2 |
| AT adapter (extended) | `prepare()` returns `{messages, tools}` | `src/eval/adapters/assistant-traj.ts` | J2 (+J5 hookup) |
| AT grader (extended) | Old evaluateSpec + new evaluateToolCalls | `src/eval/adapters/assistant-traj.ts` | J5 |
| Corpus files | 50 task JSONs + 50 fixture JSONs | `benchmarks/assistant_traj/tasks/*.json` + `tool_fixtures/*.json` | J3, J4 |
| Importer (jay-canvas → AT-v2) | One-shot script; not committed long-term workflow | `scripts/import-jay-canvas-tools.ts` | J3 |

### 2.4 Public contracts

```typescript
// src/eval/types.ts — Conversation extended (backwards-compat: tools optional)
export type Conversation = {
  messages: Message[]
  tools?: Record<string, AiSdkTool>      // NEW; optional; consumers must tolerate undefined
}

// AI SDK v6 tool shape (re-exported for clarity; we don't fork it):
export type AiSdkTool = {
  description?: string
  inputSchema: z.ZodTypeAny | JsonSchema  // we author Zod, providers serialize to JSON Schema
  execute: (input: unknown) => Promise<{ content: ContentPart[]; isError?: boolean }>
}

// src/eval/adapters/assistant-traj.tools.ts — Tool catalogue
export const AT_TOOL_NAMES = ['image_gen', 'google_search', 'web_fetch', 'code_interpreter'] as const
export type AtToolName = typeof AT_TOOL_NAMES[number]

export type ToolDispatcher = {
  mode: 'replay' | 'live'
  forTask(task: AssistantTrajTask): Record<AtToolName, AiSdkTool>  // per-task — replay needs fixture state
}

// src/eval/types.ts — Score extended (optional field; cross-bench safe)
export type Score = {
  primary: number
  judge_explanation?: string
  judge_cost_usd?: number
  tool_coherence?: { required_called: number; required_total: number; pass: boolean }  // NEW; AT-only
}
```

**Inv:** любая правка типов выше — отдельный PR + запись в `decisions.md`.
Particularly `Conversation.tools` — это cross-bench surface change.

---

## 3. Tool set

Ровно 4 тула в AT-v2. Выбор обоснован: (a) reuse-ratio из jay-canvas seed corpus
максимизирован — это покрывает >70% jay-canvas `expected.tools` activity
(`create_image` ×34, `google_search` ×4, плюс code_interpreter и web fetch — вторая
половина естественно вписывается в research_write); (b) каждый тул выдаёт
**текстуально различный output shape**, что хорошо стресс-тестит compaction
(image-url vs search snippets vs raw markdown vs stdout/stderr — разные truncation
risks).

### 3.1 Definitions (AI SDK v6 `tool()` shape, Zod input schemas)

```typescript
// All tools share return shape: { content: ContentPart[]; isError?: boolean }
// where ContentPart = D §2 ContentPart (text | image | file | tool_use | tool_result-nested).
// For the four tools below `content` is always [{type:'text', text:...}] or
// [{type:'text'}, {type:'image'}] (for image_gen).

image_gen = tool({
  description: 'Generate an image from a text prompt. Returns image URL plus short caption.',
  inputSchema: z.object({
    prompt: z.string().min(1).max(2000),
    n: z.number().int().min(1).max(4).optional(),
    size: z.enum(['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024']).optional(),
  }),
})

google_search = tool({
  description: 'Web search via Google. Returns top-N results as title+snippet+URL list.',
  inputSchema: z.object({
    q: z.string().min(1).max(500),
    n: z.number().int().min(1).max(10).optional(),
    lang: z.string().length(2).optional(),
    country: z.string().length(2).optional(),
  }),
})

web_fetch = tool({
  description: 'Fetch a web page and return cleaned main content as Markdown. HTML only — refuses PDF/image URLs.',
  inputSchema: z.object({
    url: z.string().url(),
    max_chars: z.number().int().min(500).max(50000).optional(),  // truncates if larger
  }),
})

code_interpreter = tool({
  description: 'Execute Python 3 code in a sandbox. Returns stdout, stderr, and any generated files.',
  inputSchema: z.object({
    code: z.string().min(1).max(20000),
    timeout_ms: z.number().int().min(100).max(30000).optional(),
  }),
})
```

### 3.2 Output shapes (deterministic for replay)

| Tool | Output text shape | Optional content parts |
|---|---|---|
| `image_gen` | `Generated image: <url>\nCaption: <one-line>` | optional `{type:'image', path:'tool_fixtures/<task>/img_<idx>.png'}` if fixture ships a stub PNG |
| `google_search` | `Top N results:\n1. <title> — <snippet>\n   <url>\n2. ...` (capped 10 items) | — |
| `web_fetch` | `# <page-title>\n\n<markdown body, truncated to max_chars>` | — |
| `code_interpreter` | `STDOUT:\n<...>\n\nSTDERR:\n<...>\n\nExit: <code>` | optional `{type:'file', path:'tool_fixtures/<task>/file_<idx>'}` if code produces a file |

**Inv (J5):** replay output bytes для fixed `(task_id, tool_name, call_index)` —
**bit-stable** между прогонами. Это даёт стабильные prompt-cache keys на input
агента → стабильный `cache_read%` в `RunRecord` → честный AHC A/B (см.
`system_design §3.4` cache invariance).

### 3.3 Source of live implementations (J2)

| Tool | Live impl | Source in jay-canvas |
|---|---|---|
| `image_gen` | OpenAI Images API (`gpt-image-1` first; `dall-e-3` fallback) | `apps/platform/api/src/functions/functions.openai.ts:1-149` |
| `google_search` | Brave Search API (`api.search.brave.com`) | `apps/platform/api/src/functions/functions.brave.ts:1-90` (~80 LOC, минимальный) |
| `web_fetch` | `fetch()` + `@mozilla/readability` + `turndown` (HTML → MD) | `apps/platform/api/src/functions/functions.browse.ts` (адаптируем) |
| `code_interpreter` | `pyodide` (in-process WASM Python; нет docker dep) | jay-canvas использует remote sandbox (OpenAI code_interpreter); мы — local pyodide для self-contained MVP |

Live impls **shipped в J2 minimum-viable** (happy path + один error path), без
retry/cache wrapper'а. Production-quality live — deferred (см. §Orthogonal в Phase
map). В default replay-режиме live код не загружается — `if (mode === 'live') await import('./assistant-traj.tools-live.js')`.

---

## 4. Tool execution — Replay default, Live за флагом

### 4.1 Mode resolution

```typescript
function resolveToolMode(): 'replay' | 'live' {
  const env = process.env.AT_TOOL_MODE
  if (env === 'live') return 'live'
  return 'replay'  // default — incl. CI, eval runs, all sweeps
}
```

`AT_TOOL_MODE=live` — opt-in для manual debug, capture новых фикстур, demo.
**Never default to live** — non-determinism ломает A/B compaction (search
результаты дрейфуют, image_gen non-deterministic, web_fetch ловит rot).

### 4.2 Replay dispatcher contract

```typescript
class ReplayDispatcher {
  private callIndex: Map<AtToolName, number> = new Map()  // per tool, per task instance

  constructor(private fixtures: ToolFixture[]) {}

  async dispatch(toolName: AtToolName, input: unknown): Promise<ToolResultPayload> {
    const idx = this.callIndex.get(toolName) ?? 0
    const candidates = this.fixtures
      .filter((f) => f.tool_name === toolName)
      .filter((f, i) => this.matchInput(f, input, i, idx))
    if (candidates.length === 0) {
      throw new ToolReplayMissError(toolName, input, idx)
    }
    this.callIndex.set(toolName, idx + 1)
    return { content: candidates[0].output_parts, isError: candidates[0].is_error ?? false }
  }

  private matchInput(f: ToolFixture, input: unknown, fixtureIndex: number, callIndex: number): boolean {
    const match = f.input_match ?? { kind: 'first' }
    if (match.kind === 'first') return fixtureIndex === callIndex
    if (match.kind === 'args_exact') return deepEqual(input, match.args)
    if (match.kind === 'args_subset') return isSubset(match.args, input)
    return false
  }
}
```

**ToolReplayMissError** содержит `{task_id, tool_name, attempted_input, call_index}`.
Не silent fallback — баг в фикстуре или агент пошёл не туда; eval harness ловит
exception в `runner.ts`, конвертит в `RunRecord` с `error: 'tool_replay_miss'` для
forensic'ов в audit doc.

### 4.3 Live dispatcher contract (minimal, J2)

```typescript
class LiveDispatcher {
  async dispatch(toolName: AtToolName, input: unknown): Promise<ToolResultPayload> {
    if (toolName === 'image_gen') return openaiImages(input)
    if (toolName === 'google_search') return braveSearch(input)
    if (toolName === 'web_fetch') return fetchAndReadability(input)
    if (toolName === 'code_interpreter') return pyodideExec(input)
    throw new Error(`unknown tool: ${toolName}`)
  }
}
```

ENV перечисление (J2):
- `OPENAI_API_KEY` — для `image_gen`
- `BRAVE_API_KEY` — для `google_search`
- `web_fetch` — без secret'а
- `code_interpreter` — без secret'а (pyodide локальный)

### 4.4 Capture flow (live → fixture)

Скрипт `scripts/capture-at-fixture.ts` (J2 stretch, может быть пост-PR):
- Запускает task через live dispatcher с заглушённым `actor` (одно proxy-обращение к
  агенту).
- Логирует каждый tool-call с input + output.
- Эмитит `tool_fixtures/<task_id>.json` с записанной trace'ой.
- Manual review перед commit.

Это путь как мы создаём фикстуры для **новых** synthetic task'ов в J4.

---

## 5. Task corpus (50 tasks)

### 5.1 Target distribution

| Category | AT-v1 (drop) | AT-v2 (this) | Primary tools | Source priority |
|---|---|---|---|---|
| `image_qa` | 8 | 8 | `image_gen` (follow-up generate), `web_fetch` (look up reference) | jay-canvas IG/IE/MX → synthetic |
| `code_iter` | 8 | 14 | `code_interpreter` (heavy), `web_fetch` (docs lookup) | jay-canvas CD → synthetic |
| `research_write` | 8 | 14 | `google_search`, `web_fetch` (heavy) | jay-canvas QA/WC/ED → synthetic |
| `mixed` | 6 | 14 | cross-tool: 2+ different tools per task | jay-canvas MX/A/AM → synthetic |
| **Total** | 30 | **50** | — | — |

**Rationale для перекоса в research_write / mixed:** именно эти категории
максимизируют **trajectory-coherence stress**: long tool result (`web_fetch`
markdown) + multi-turn follow-up — это и есть failure mode что AHC должен лечить
без потери compaction quality. Image-grounded — стабильно короткие tool outputs,
менее интересны для compaction A/B.

### 5.2 Sourcing breakdown (estimated yield)

jay-canvas golden-set даёт нам ~80 scenarios; **не все мигрируют** — фильтры:
- DROP сценариев где `expected.tools=[]` без compaction-interesting контента
  (single-turn text Q&A — это LME territory).
- DROP scenario'ев с tools вне нашей 4-tool palette (`generate_video`,
  `generate_music`, `edit_image` — пока выпадают; `edit_image` может вернуться
  в J extension если корпус большой).
- KEEP сценарии с `expected.tools` ∈ {`create_image`→`image_gen`, `google_search`,
  `code_interpreter`, `browse_url`→`web_fetch`} **или** scenarios которые
  естественно перепридумываются под одну из этих 4 (research_write часто
  natively просит google_search даже если в jay-canvas tool не вызвался).

Estimated yield (~50% pass-through): **~30 tasks из jay-canvas** → **J3**.
Top-up до 50: **~20 synthetic** в J4. Если jay-canvas даёт <30, J4 догенерит больше.

### 5.3 Hand-extension rule (carried from D §3.1)

jay-canvas scenarios часто 1–2 turn. AT-v2 medium-traj target — 5–15 turns. Importer
проектирует initial 1–2, agent + Aleksei handcraft 3–13 follow-up turn (refinements,
re-prompts, image variations, debug iterations), сохраняя arc.

### 5.4 Synthetic top-up rules (J4)

- Тема разнообразна; не один шаблон per category.
- **100% manual review** каждой synthetic трассы (D §3.3 carried).
- Fixture генерируется через `capture-at-fixture.ts` (live mode) → review →
  commit.
- `source:'synthetic'` + `provenance.review_signoff` non-empty (gate в validator).

---

## 6. Grader — tool-call coherence

### 6.1 Contract (extending D §5)

```typescript
function evaluateAssistantTrajResponse(task, response): Score {
  const contentScore = evaluateSpec(task.evaluation, response.text, task, deps)  // D §5 unchanged
  const toolScore = evaluateToolCalls(task.expected_tool_calls, response.toolCalls)
  return aggregate(contentScore, toolScore)
}

function evaluateToolCalls(
  expected: ToolCallExpectation[],   // from any turn in task.turns
  actual: { name: string; args: unknown }[],   // emitted by agent loop
): { required_called: number; required_total: number; pass: boolean } {
  const required = expected.filter((e) => e.required === true)
  let called = 0
  for (const req of required) {
    const hit = actual.find((a) => a.name === req.tool_name && argsMatch(req.args_match, a.args, req))
    if (hit) called += 1
  }
  return { required_called: called, required_total: required.length, pass: called === required.length }
}
```

`argsMatch`:
- `'exact'` — `deepEqual(actual, expectedExample)` (expectedExample lives в task — opt-in field on `ToolCallExpectation`)
- `'subset'` — все ключи expectedExample присутствуют в actual с равными значениями
- `'semantic'` — **deferred** (см. §11 Q2)
- absent — pass (любые args ок)

### 6.2 Aggregation: content score × tool coherence

Default rule (J5):

```
final.primary = content.primary * (tool_coherence.pass ? 1.0 : 0.0)
```

**Hard gate** — без вызова required tool ответ не зачитывается. Это намеренно
жёсткое поведение; контентный ответ может быть «правильным на словах» (LLM запомнил
текст из системы), но без tool-call мы не знаем что compaction не сожрал нужную
информацию для tool decision.

Soft alternative (`final.primary = content.primary * (called/total)`) — обсуждается
как Q1 в §11; не дефолт в J5.

`score.tool_coherence` всегда populated в AT — даже при `pass=true` (для audit
visibility в `RunRecord`).

### 6.3 Judge cache (D §6.2 reuse)

Cache key — `sha256(task_id + response.text)`. AT-v1 cache (~260 KB) не
очищается; новые `task_id` (`at_*_001` через `at_*_050` после rebalance) → новые keys
автоматически. Старые keys orphaned, занимают место, но никого не ломают. Cleanup —
optional follow-up.

**Cross-check (J6 acceptance):** на первом полном E1 sweep против AT-v2 →
`hit-rate ≥ 50%` при повторном прогоне (тот же baseline, тот же seed). Если ниже —
non-determinism утёк (вероятно из replay dispatch'а).

---

## 7. Storage layout (delta к D §7)

```
benchmarks/assistant_traj/
  tasks/
    at_image_qa_001.json           # 50 файлов всего после J3+J4
    ...
    at_mixed_014.json
  tool_fixtures/                   # NEW (J)
    at_image_qa_001.json           # 1:1 с tasks/
    ...
    at_mixed_014.json
  attachments/
    at_image_qa_001/               # пользовательский input images, как было в D
    ...
  rubrics/                         # без изменений (D §6)
    image_qa.md
    code_iter.md
    research_write.md
    mixed.md
  calibration/
    human_scores.json              # перегенерируется на J6 — 10% × 50 = 5 task'ов
  judge_cache.json                 # carry-forward (см. §6.3)
  README.md                        # обновляется в J6 — 30→50, tools list
  validate.ts                      # обновляется в J1 — cross-check task ↔ tool_fixtures pair
```

`fixtures/valid/` и `fixtures/invalid/` (D1 smoke) — расширяются в J1 minimum:
один новый valid (task with `tools_available` + paired fixture), один новый
invalid (task с `expected_tool_calls.required=true` but empty `tools_available` —
schema reject). Sidecar `.reason.txt` для invalid — как в D.

---

## 8. Migration — AT-v1 retire

### 8.1 Что удаляется (J3)

```
benchmarks/assistant_traj/tasks/at_image_qa_001.json … at_mixed_006.json   (30 files)
benchmarks/assistant_traj/attachments/at_image_qa_*/* … at_mixed_*/*        (только AT-v1)
```

Один коммит, `git rm`. История сохраняется в git log.

### 8.2 Что не удаляется

- `judge_cache.json` — carry-forward (orphaned entries безвредны).
- `rubrics/*.md` — переиспользуются.
- `calibration/human_scores.json` — пересчитывается на J6 (5 новых task'ов человеком).

### 8.3 Numbers retire

`docs/runs/baselines_frozen.md` (recent commit `0a4d809` создал его) уже
содержит inline AT-corpus version note (AT-v1 retire + AT-v2 forward
pointer). J6 sweep дописывает к Text benches table 5 новых строк (5
baselines × AT-v2) с пометкой "AT-v2"; AT-v1 строки остаются с retire-note
inline.

Что landed (per-baseline на AT-v2 corpus, 1 seed):
- 5 baselines: full_context, anthropic_compact, mastra_om, mastra_agent, ahc_core.
- diff vs AT-v1 (если signal есть — например full_context на AT-v2 ниже потому
  что 50% задач теперь требуют live tool результат, который full_context "забывает"
  на длинных историях; AHC должен лечить — это и есть hypothesis).

(Pre-restructure 2026-05-26 этот раздел указывал на `docs/runs/at_v2_baselines.md`
как на отдельный файл — он был stub без чисел и retire'ился в одной плоскости
с другими per-track audit doc'ами; см. `git log --diff-filter=D docs/runs/`.)

### 8.4 Sweep YAMLs

`eval/sweeps/main_e1_text_lme_mt_n50.yaml` — содержит assistant_traj row?

```bash
# проверка перед J6 cutover
grep -l assistant_traj eval/sweeps/*.yaml
```

Каждый sweep с assistant_traj — правка row на `n=50` (или удаление task-limit'а
если был); никаких структурных изменений.

---

## 9. Track D §9 patch — compaction axis framing

Track D `§9` (bench role in AHC eval) — таблица. AT строка обновляется:

```diff
- | **AssistantTraj** | trajectory coherence | multi-turn replay assistant trace | trajectory drift через compaction |
+ | **AssistantTraj-v2** | trajectory coherence + tool-call coherence | multi-turn replay assistant trace **with mocked tools** (image_gen, google_search, web_fetch, code_interpreter) | trajectory drift + **required tool-call drop** под compaction (no live env-state — отличие от τ-bench) |
```

Это **не** превращает AT в τ-bench: tau-bench отличается тем что у него **live
env-state** (cart, db rows, write-actions через tools), который меняется
между шагами агента и проверяется в финале. AT-v2 tools — **stateless replay**:
каждый вызов независимый, нет cart-ish persistence. AT-v2 проверяет «помнит ли
агент что нужный tool *надо вызвать*» — это про compaction, не про tool RL.

Patch применяется одним правкой `docs/design/D_assistant-traj.md` в J6 PR.

---

## 10. Инварианты

Hard contracts, любое изменение в Track J должно сохранять.

### 10.1 Cache invariance (system_design §3.4 carried)

Между AHC ON / AHC OFF при одинаковом seed на одной AT task — `cache_read%`
отличается **только** на токенах что AHC реально удалил/перенёс. Replay-tool
output bytes — bit-identical между прогонами (см. §3.2 Inv), поэтому prompt
prefix tool-result'ов кэшируется идентично. Тест: `vitest`
`assistant-traj.cache.test.ts` (J5/J6 boundary).

### 10.2 Replay determinism

`runSweep(sameTask, sameBaseline, sameSeed)` дважды → identical `response.text`
(модулo provider jitter — отдельный seed-stability investigation, не J scope).
Tool outputs by definition identical (fixture). Replay miss → `error:'tool_replay_miss'`
+ task fails fast (no silent fallback to live).

### 10.3 Schema gate — `tools_available` ↔ `expected_tool_calls`

Cross-field rule в `AssistantTrajTaskSchema` (J1):

```
if any turn has expected_tool_calls with required:true
then tools_available.length >= 1
     AND every required expected_tool_calls[].tool_name ∈ tools_available[].name
```

Невозможна task где required tool не в палитре agent'а. Unit test +
`benchmarks/assistant_traj/fixtures/invalid/` entry.

### 10.4 Fixture ↔ task pair invariant

`validate.ts` проверяет:
- для каждого `tasks/at_*.json` с непустым `tools_available` → существует
  `tool_fixtures/at_*.json`
- task_id внутри fixture file == filename
- каждый `ToolFixture.tool_name` ∈ AT_TOOL_NAMES (4 значения)

### 10.5 Live mode никогда не default

```typescript
// at the top of every adapter init:
if (process.env.AT_TOOL_MODE === 'live' && process.env.CI === 'true') {
  throw new Error('AT_TOOL_MODE=live forbidden in CI — eval determinism would break')
}
```

CI guard в `scripts/verify.sh` (или в runner) — гарантирует что числа в
`baselines_frozen.md` / sweep results не дрейфят из-за случайно зафиксированной
live переменной в env.

---

## 11. Open questions

- **Q1** — Aggregation rule `content × tool_coherence` (§6.2): hard-gate (0 если
  required tool не вызван) vs proportional (`called/total` scaling). Default
  hard-gate в J5. Revisit после J6 при ≥ 30% drop у `full_context` baseline —
  возможно слишком строго и стирает trajectory-quality signal. Decision deadline:
  AT-v2 baselines pass в J6.
- **Q2** — `args_match: 'semantic'` (LLM-judge на args корректность) — deferred.
  Активируется если J3/J4 corpus содержит task где tool вызван с
  «правильным intent но неправильным literal args» — пока что в jay-canvas seed
  такого нет. Reopens в F-report Discussion если baseline дрейф большой.
- **Q3** — `Score.tool_coherence` как cross-bench field или AT-only? Сейчас
  optional → cross-bench safe; но aggregator (P5 audit / `at_pareto.py`) пока
  его игнорит. Decision при первом cross-bench Pareto plot который захочет
  factorize по «вызвал ли required tool».
- **Q4** — Image attachments output (image_gen → fixture image file): хранить
  binary PNG в `tool_fixtures/<task>/img_*.png` (увеличит репо) или генерировать
  при capture стабильный placeholder image-url? Default — placeholder URL
  (`https://example.com/at-img/<task>-<idx>.png`, не fetched), реальные PNG
  в репо не коммитим. Revisit если judge image-eval требует реальное content.
- **Q5** — Source `'real'` нужен для AT-v2? D `§4` anonymization dropped (synthetic
  + opensource only path). В AT-v2 ничего не меняется — `source` ∈ {`opensource`
  (jay-canvas-seeded), `synthetic`}. `'real'` остаётся в schema как dormant per
  D §4 decision.
- **Q6** — `code_interpreter` live = pyodide vs subprocess(`python3`). Default
  pyodide (нет docker/system Python dependency), но pyodide медленный на cold
  start (~3s). При J2 если pyodide > 5s на простом `print(1+1)` — fallback к
  subprocess. Решается в J2 impl.
