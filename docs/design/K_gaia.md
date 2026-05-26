# Track K Design — `gaia-med` bench (GAIA cross-domain agentic)

> Track-level design для пятого bench'а нашего eval-harness — `gaia-med`
> (GAIA General AI Assistants benchmark, Mialon et al. 2023, CC BY 4.0,
> `gaia-benchmark/GAIA` на HuggingFace). Закрывает gap в agentic axis:
> `tau-bench-retail-med` узко-доменный retail (10 tools, фиксированный
> env), GAIA cross-domain (research + web + code + multimodal, knowledge
> accumulation between tool calls). Реализуется в
> `src/eval/adapters/gaia-med.ts` + `src/eval/adapters/gaia-tools/*.ts` +
> `src/eval/adapters/gaia-med/agent-runner.ts`. Phase plan —
> `system_design §7.2 Track K` (введён одним PR с этим документом).

> **Prereq.** Step 0 (вместе с этим doc'ом) — добавлены `system_design.md
> §7.1+§7.2` Track K rows, `docs/index.md` routing entry, `decisions.md`
> запись про pure-normalization grader. Без них design doc висит в
> воздухе.

---

## Meta

- **Initiative:** Track K (K1 bench scaffold → K2 5-tool port → K3 agent
  runner + dispatch → K4 sweep + audit)
- **Wall-clock:** ~6-7 дней
- **Бюджет:** ~$30-50 на main sweep (n=30, gpt-5.4-mini actor, +Tavily
  web_search API). Smoke ~$2-3.
- **Зависит от:**
  - `tau-bench-retail/agent-runner.ts` — template для agentic runner
    shape (multi-step tool loop, no user-sim).
  - AHC core (для downstream baseline integration с `ahc_core`).
  - Holosophus local snapshot
    (`/Users/Aleksei/Projects/ai_scientists/Holosophus/holosophos/
    evals_and_reports/data/gaia_validation_30.json` + attachments dir) —
    vendored в `references/gaia/data/` в K1.
  - External tool APIs: Tavily (`TAVILY_API_KEY`) + Brave fallback
    (`BRAVE_API_KEY`) для `web_search`. Vision-capable model через
    OpenRouter для `describe_image` (gpt-5.4-mini supports image input).
- **Блокирует:** F-report cross-bench Pareto fifth-point (без K4 audit
  чисел F-report остаётся 4-bench narrative).
- **Связь:**
  - `decisions.md 2026-05-22` — pure-normalization grader.
  - `docs/design/I_mastra_agent.md` — cross-framework agentic precedent
    (как baseline без AHC закрывает gap; здесь — как новый bench
    открывает axis).
  - `docs/design/D_assistant-traj.md §9` — eval axes framework (GAIA
    позиционируется как **cross-domain agentic-state**).
  - `docs/benchmarks.md` — справочник по 4 существующим benches; entry
    для GAIA добавится post-K4 audit когда числа stable.

---

## Outcomes

> Что становится видимым артефактом и как это проверить.

### Track K (после K4)

**Что становится видимым:**
- `gaia-med` зарегистрирован как Bench в `src/eval/types.ts` union,
  `defaultAdapterRegistry.resolve('gaia-med')` возвращает adapter.
- 5 tools registered в `src/eval/adapters/gaia-tools/` (AI SDK v6
  `tool()` shape, mirror tau-retail tools.ts pattern).
- `eval/sweeps/main_e1_gaia.yaml` complete'ит N baselines × 30 tasks ×
  seed=42, NDJSON в `benchmarks/runs/main_e1_gaia/gaia-med/<config>/42/`.
- Per-level accuracy + per-tool usage distribution + cache rate + cost
  лягут в `docs/runs/baselines_frozen.md` gaia-med section (К-tail-2
  consolidated narrative включён). `k_gaia_audit.md` retired 2026-05-26
  — full original в `git log --diff-filter=D docs/runs/`.
- `docs/benchmarks.md` — добавлен §5 для `gaia-med` (sample shape,
  scoring, system prompt, tools).
- `docs/runs/baselines_frozen.md` — добавлены competitor rows для
  `gaia-med` (full_context / mastra_om / anthropic_compact если applicable).

**Demo (e2e smoke):**
```bash
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml --concurrency=1
# 1 task × 1 baseline (full_context) ~$1-2, ~5-10 min.
# Should produce NDJSON с response containing "Final answer: <X>",
# n_tool_calls >= 1, cost_usd > 0.
```

**Acceptance gate:**
- `./scripts/verify.sh all` зелёный.
- K-smoke test (`pnpm exec vitest run src/eval/adapters/gaia-med.live.test.ts -t "live smoke"`)
  завершает 1 level-1 task end-to-end без exception, response contains
  "Final answer:" prefix, score.primary ∈ {0, 1.0}.
- Live `web_search` returns ≥1 result; live `python_exec` correctly
  applies 30s timeout.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify |
|---|---|---|
| **K1** Bench scaffold | `references/gaia/data/gaia_validation_30.json` vendored + LICENSE; `scripts/bake-gaia.ts` produces 23-26 baked tasks в `benchmarks/gaia/tasks/gaia_*.json` (attachment-tasks filtered); `src/eval/adapters/gaia-med.{ts,schema.ts}` (`loadTasks` + `prepare` + `createGaiaGrader`); 5 grader unit tests зелёные | `pnpm exec vitest run src/eval/adapters/gaia-med.test.ts` (unit) + `pnpm tsx scripts/bake-gaia.ts references/gaia/data/gaia_validation_30.json` идемпотентен |
| **K2** Tools port | `src/eval/adapters/gaia-tools/{web-search,visit-webpage,text-editor,python-exec,describe-image}.ts` — 5 tools с unit (mocked) + 1 live-gated smoke each | `pnpm exec vitest run src/eval/adapters/gaia-tools/` (unit) + live smokes (gated по `TAVILY_API_KEY`) |
| **K3** Runner + dispatch | `src/eval/adapters/gaia-med/agent-runner.ts` с `runGaiaTask(task, deps)`; `src/eval/runner.ts` имеет dispatch для `bench='gaia-med'`; 1 live smoke task проходит end-to-end | `pnpm exec vitest run src/eval/adapters/gaia-med/agent-runner.test.ts` + live smoke `pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml --max-tasks-per-cell=1` |
| **K4** Sweep + audit | `benchmarks/runs/main_e1_gaia/<bench>/<config>/42/{summary.json,records.ndjson,meta.json}` populated; per-level acc + caveats + competitor rows лежат в `docs/runs/baselines_frozen.md` gaia-med section; `docs/benchmarks.md §5` добавлен | `pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_gaia/` показывает cells со status=complete |

---

## Phase map

Source of truth по фазам — `system_design §7.2 Track K`. Колонки см.
`docs/templates/track_design_template.md`.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **K1** Bench scaffold (1 день) | Holosophus snapshot copied | K3 | §2.1, §2.2, §3 | `GaiaTask` (Zod), `Grader` impl `createGaiaGrader`, bake-script CLI | Failing unit: `score(task{answer:"25"}, "Final answer: 25")` → `{primary: 1.0}`; ещё 4 cases (list / text / mismatch / missing-Final) | §3.4 failure modes; `B_eval-harness.md §3` RunRecord |
| **K2** Tools port (3 дня) | K1 | K3 | §4, §4.1, §4.2 | 5 tool definitions (AI SDK `tool({inputSchema: jsonSchema(...), execute})` shape, mirror `tau-bench-retail/tools.ts:164`) | Failing unit на каждый tool: `webSearch({query: "test"})` returns array (mocked Tavily); `pythonExec({code: "while True: pass"})` timeout fires в 30s; `visitWebpage({url})` truncates до 50K | §4.3 failure modes; `decisions.md 2026-05-13 D5` (AI SDK v6 native engine, не custom ReACT) |
| **K3** Runner + dispatch (1.5 дня) | K1, K2 | K4 | §5, §5.1 | `runGaiaTask(task, deps)` parallel `runTauEpisode`; bench-dispatch в `src/eval/runner.ts` | Failing live smoke: 1 level-1 task → возвращает text с "Final answer:", `n_tool_calls ≥ 1`, no exception | §5.2 baseline-tools investigation; `tau-bench-retail/agent-runner.ts` (template) |
| **K4** Sweep + audit (1 день) | K3 | F-report (опционально) | §6, §7 | `eval/sweeps/{smoke,main_e1}_gaia.yaml`; gaia-med section в `docs/runs/baselines_frozen.md` | Pre-flight: `pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml --max-tasks-per-cell=1` exit 0; post-run: sanity-aggregate показывает status=complete | `docs/runs/baselines_frozen.md` (5 benches теперь); `docs/benchmarks.md §5`; `docs/runs/current.md` Track K (К-tail-3 deferred) |

**Parallelization:** K1 → K2 строго (K2 наследует bench setup из K1).
K3 ждёт K1+K2. K4 ждёт K3. Track K параллелится с любым не-bench Track-H
sweep'ом + с Track J (AT-v2) — это разные bench territories.

**Orthogonal / deferred:**
- **Cross-model GAIA** (Sonnet / Gemini вместо gpt-5.4-mini) — K5 если
  F-report попросит cross-model сравнение.
- **`gaia-full` (n=165)** — деферим после K4: если discrimination на
  n=30 недостаточна, поднимаем до full.
- **MCP server'ы** (`academia_mcp`, `mle_kit_mcp` Python services из
  Holosophus) — out of scope. Мы реализуем 5 tools как plain TS
  functions, не MCP-bridge. MCP-bridge — отдельный Track если станет
  нужен.
- **xlsx/pdf parsing** — out of scope (Medium scope decision). ~5-7
  tasks из 30 фильтруются при bake.

**Step 0 (одним PR с этим doc'ом):**
- `system_design.md §7.1+§7.2` — Track K rows.
- `docs/index.md` — routing entry для `design/K_gaia.md`.
- `docs/decisions.md` — запись 2026-05-22 о pure-normalization grader.
- **NOT** обновляем `docs/benchmarks.md` сейчас — entry добавится в K4
  когда реальные числа появятся (benchmarks.md = справочник с
  measurements, не roadmap).

---

## 1. Терминология

Локальные термины этого track'а. Переиспользуемые — см. `system_design §1`,
`D_assistant-traj.md §1`.

- **GAIA** — General AI Assistants benchmark (Mialon et al. 2023,
  `gaia-benchmark/GAIA` на HuggingFace, CC BY 4.0). 466 validation
  questions cross-domain (research / web / code / multimodal); тестирует
  general assistant capability на real-world questions с verifiable
  ground truth.
- **Level** ∈ {1, 2, 3} — difficulty tier upstream. Level 1 = easy
  (single-step lookup), Level 3 = hard (multi-tool chained reasoning,
  obscure data sources).
- **`gaia-med`** — наш bench id (mirror `lme-med` / `locomo-med` /
  `tau-bench-retail-med` convention). n=30 stratified subset из 165-q
  validation split, взят у Holosophus (`gaia_validation_30.json`),
  pre-balanced across levels.
- **Stratified subset** — Holosophus stratification (примерно 12 level-1,
  14 level-2, 4 level-3). Мы не пересчитываем стратификацию — берём
  готовый subset с attribution.
- **Exact-match normalization** — пусть `_a = normalize(answer)`,
  `_r = normalize(extracted_response)`; `score = (_a === _r) ? 1.0 : 0.0`.
  Normalization rules port verbatim из Holosophus
  `get_gaia_metrics.py:88-127`: numeric (strip `$,%,`, parseFloat,
  equality), list (split by `,;` → element-wise normalize → set equality),
  text (lowercase + strip whitespace/punctuation, string equality).
- **Final answer extraction** — split actor response on `"Final answer:"`
  (case-sensitive), take last segment, trim. Fallback: full text if
  prefix absent.
- **Attachment-task** — GAIA task с `has_file: true`. Holosophus dataset
  включает xlsx/pdf/png attachments в `data/attachments/`; мы skipping
  xlsx/pdf при bake, supporting только image-attachment tasks через
  `describe_image` tool в K2.
- **Effective n** — n=30 после filtering attachment-tasks ≈ 23-26 (точное
  число фиксируется в K1 audit при bake).

---

## 2. Архитектура

### 2.1 Зачем GAIA в эволюции eval-protocol'а

Текущие 4 bench'а покрывают 3 compaction failure modes (per
`D_assistant-traj.md §9` framework):

| Bench | Axis | Тестирует |
|---|---|---|
| `assistant-traj` | trajectory coherence | medium-traj replay (5-15 turns), multimodal user inputs |
| `longmemeval-med` / `lme-multiturn` | passive recall | long-context fact extraction |
| `locomo-med` | passive recall (dialog) | long-range temporal anchors |
| `tau-bench-retail-med` | agentic state | live tool loop + user-sim, env-state coherence |

**Gap до Track K**: agentic axis покрыт только tau-retail — узкая
domain (10 retail tools, single env: orders/users/products). Mastra-agent
(Track I) closes framework-native competitor gap, но bench всё ещё один.

**Что GAIA добавляет** (per `feedback_eval_component_purpose`):
- **Failure mode**: «AHC compaction quality генерализуется ли на
  cross-domain agentic workload?» Tau тестирует knowledge о narrow env
  (зак ⇄ адрес ⇄ возврат); GAIA тестирует knowledge accumulation across
  гетерогенных tool results — web pages (text, ~5-50K chars), arxiv
  abstracts, Python output, image descriptions.
- **Irreducibility vs tau-retail**:
  - Diverse tool-result shapes (vs single-domain JSON env mutations).
  - **Knowledge integration** between calls (GAIA tasks типично требуют
    chained reasoning across 2-5 tool calls с aggregation), не state
    mutations.
  - Real-world ground truth (research-anchored, verifiable), не replay
    оценок.
- **Irreducibility vs lme/locomo**: those — passive QA over fixed
  haystack. GAIA — agent сам gathers haystack via tool calls (dynamic
  context construction).

### 2.2 Data flow per task

```
1. loadTasks(seed=42) → 23-26 GaiaTask records (post-attachment-filter)
2. For each task:
   a. prepare(task) → Conversation{
        messages: [{role: 'user', content: renderGaiaPrompt(task)}],
        tools: [web_search, visit_webpage, text_editor, python_exec,
                describe_image]  // sub-set wired by runner
      }
   b. Runner: generateText(messages, {
        tools, stopWhen: stepCountIs(20), system: GAIA_SYSTEM_PROMPT
      })
   c. AI SDK v6 orchestrates internal multi-step loop (model →
      tool_call → execute → tool_result → model → ...) до text-only
      response или maxSteps cap.
   d. Extract final answer: split response.text on "Final answer:",
      trim last segment.
   e. score(task, extracted) → normalize numeric/list/text → equality →
      Score{primary: 0|1}.
3. Aggregate per-level accuracy in audit.
```

### 2.3 Modules

| Module | Role | File | Track-phase |
|---|---|---|---|
| References vendoring | Holosophus snapshot copy + LICENSE | `references/gaia/{data,README.md}` | K1 |
| Bake | Validate + filter + write baked tasks | `scripts/bake-gaia.ts` | K1 |
| Schema | Zod validator + type | `src/eval/adapters/gaia-med.schema.ts` | K1 |
| Adapter | `loadTasks`, `prepare`, `createGaiaGrader`, `GAIA_DRIVER_SYSTEM` | `src/eval/adapters/gaia-med.ts` | K1 |
| Tools | 5 tool definitions | `src/eval/adapters/gaia-tools/{web-search,visit-webpage,text-editor,python-exec,describe-image}.ts` | K2 |
| Episode runner | Actor loop с GAIA tools | `src/eval/adapters/gaia-med/agent-runner.ts` | K3 |
| Runner dispatch | bench-to-runner factory | `src/eval/runner.ts` (edit) | K3 |
| Sweep configs | Smoke + main | `eval/sweeps/{smoke,main_e1}_gaia.yaml` | K4 |
| Numbers + caveats | Per-level acc + per-tool distribution + К-tail narratives | `docs/runs/baselines_frozen.md` gaia-med section | K4 |

### 2.4 Public types / contracts

```typescript
// src/eval/adapters/gaia-med.schema.ts
const GaiaTaskSchema = z.object({
  idx: z.number().int().min(0),
  question: z.string().min(1),
  answer: z.string().min(1),
  level: z.enum(['1', '2', '3']),
  has_file: z.boolean(),
  file_path: z.string()  // may be ""
})
export type GaiaTask = z.infer<typeof GaiaTaskSchema>

// src/eval/adapters/gaia-med.ts
export const gaiaMedAdapter: BenchAdapter = {
  name: 'gaia-med',
  async loadTasks(_seed: number): Promise<Task[]> { /* read baked files */ },
  prepare(task: Task): Conversation { /* user msg + tools wired by runner */ }
}

export type GaiaGraderDeps = { /* none required — pure functions */ }
export function createGaiaGrader(deps?: GaiaGraderDeps): Grader {
  return {
    async score(task: Task, response: RunnerResponse): Promise<Score> { ... }
  }
}

export const GAIA_DRIVER_SYSTEM: string = `...verbatim Holosophus...`

// src/eval/adapters/gaia-med/agent-runner.ts
export type RunGaiaTaskDeps = {
  actorModel: LanguageModelV3
  actorSystem: string
  tools: Record<string, AISdkTool>
  actorModelId?: string
  actorPricing?: ModelPricing
  maxSteps?: number
  emit?: (e: InstrumentationEvent) => void
}

export type GaiaTaskResult = {
  response: string  // final assistant text containing "Final answer: X"
  n_steps: number
  n_tool_calls: number
  cost_usd: number
  totals: { input: number; output: number }
  events: InstrumentationEvent[]
  errors: { turn_index: number; kind: 'api_error'; message: string }[]
}

export async function runGaiaTask(
  task: GaiaTask,
  deps: RunGaiaTaskDeps
): Promise<GaiaTaskResult>
```

`Bench` union в `src/eval/types.ts` расширяется одним литералом
`'gaia-med'` — strict typecheck гарантирует что dispatch покрыт.

---

## 3. Grader (exact-match с normalization)

### 3.1 Contract

```typescript
score(task: GaiaTask, response: RunnerResponse): Promise<Score>
```

- Reads `response.text` (final assistant text — AI SDK v6
  `generateText` returns text после tools resolved).
- Extracts via `_getFinalAnswer(text)`: splits on `"Final answer:**"`
  first (markdown bold form Holosophus emits sometimes), затем
  `"Final answer:"`, trim last segment. Fallback: full text.
- Normalizes both extracted и `task.answer`, returns
  `{primary: 1.0 | 0.0, secondary: { extracted, normalized_expected,
  normalized_actual }, judge_cost_usd: 0}`.

### 3.2 Normalization rules (port from Holosophus)

Source: `/Users/Aleksei/Projects/ai_scientists/Holosophus/holosophos/
evals_and_reports/get_gaia_metrics.py:88-127`.

```typescript
function _answerScorer(modelAnswer: string, groundTruth: string): boolean {
  if (isFloat(groundTruth)) {
    // Numeric path
    const normalized = _normalizeNumberStr(modelAnswer)
    return normalized !== null && normalized === parseFloat(groundTruth)
  }
  if (/[,;]/.test(groundTruth)) {
    // List path
    const gtElems = _splitString(groundTruth)
    const maElems = _splitString(modelAnswer)
    if (gtElems.length !== maElems.length) return false
    // Per-element: try numeric first then text
    return gtElems.every((gt, i) => {
      if (isFloat(gt)) {
        return _normalizeNumberStr(maElems[i]) === parseFloat(gt)
      }
      return _normalizeStr(maElems[i]) === _normalizeStr(gt)
    })
  }
  // Text path
  return _normalizeStr(modelAnswer) === _normalizeStr(groundTruth)
}

function _normalizeNumberStr(s: string): number | null {
  const cleaned = s.replace(/[$,%]/g, '').trim()
  const v = parseFloat(cleaned)
  return Number.isFinite(v) ? v : null
}

function _normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]/gu, '')
}

function _splitString(s: string): string[] {
  return s.split(/[,;]/).map(x => x.trim()).filter(x => x.length > 0)
}

function isFloat(s: string): boolean {
  const v = parseFloat(s)
  return Number.isFinite(v) && /^[+-]?[\d.]+([eE][+-]?\d+)?$/.test(s.trim())
}
```

### 3.3 Pseudocode для full scoring path

```
input: task, response
extracted = _getFinalAnswer(response.text)
if extracted.trim().length === 0:
  return Score{primary: 0, secondary: {error: 'empty_answer'}}
correct = _answerScorer(extracted, task.answer)
return Score{
  primary: correct ? 1.0 : 0.0,
  secondary: { extracted, ground_truth: task.answer, level: task.level },
  judge_cost_usd: 0
}
```

### 3.4 Failure modes / fallbacks

- **Actor не emit'ит "Final answer:"** — fallback uses full text. Часто
  всё равно мetches на short numeric answers ("17"). Логируется в
  audit как fallback rate.
- **Numeric formatting drift** ("2 thousand" vs "2000"): GAIA prompt
  explicitly требует raw numbers без units; нормализация не handle
  natural-language numbers ("two") — это intended (GAIA fidelity).
- **Ambiguous text answers** ("egalitarian." vs "egalitarian"): trailing
  punctuation strip handles этот case. Caveat в §7: 5-10% false-negative
  rate возможен на ambiguous answers (Holosophus accepts тот же
  trade-off).
- **List ordering**: Holosophus does element-wise equality в обоих
  направлениях. Наш порт сохраняет verbatim behaviour — strict by
  position. **Open Q3 §7**: switch to set-equality? F-report сравнение
  cross-paper требует verbatim Holosophus convention; deferred.

---

## 4. Tools (5-tool surface, Medium scope)

### 4.1 Surface

Все 5 — AI SDK v6 `tool({description, inputSchema: jsonSchema(...),
execute})` shape (mirror `tau-bench-retail/tools.ts:164-172`). NO Zod:
AI SDK v6 + Zod 4 type-inference incompatible (per `decisions.md
2026-05-13 D5 tau-bench engine`).

| # | Tool | Input | Output | Cost surface |
|---|---|---|---|---|
| 1 | `web_search` | `{query: string, max_results?: number}` | `{title, url, snippet}[]` | Tavily/Brave API ~$0.005-0.01/call |
| 2 | `visit_webpage` | `{url: string}` | `{title: string, text_content: string (≤50K chars)}` | Network bytes only |
| 3 | `text_editor` | `{path: string}` | `{content: string (≤100KB)}` | Filesystem read |
| 4 | `python_exec` | `{code: string}` | `{stdout, stderr, exit_code: number}` | Subprocess + 30s timeout |
| 5 | `describe_image` | `{image_path: string, question: string}` | `{description: string}` | Vision LLM call ~$0.001-0.003/call |

### 4.2 Tool details

**`web_search`**
- Primary: Tavily (`https://api.tavily.com/search`, header
  `Authorization: Bearer ${TAVILY_API_KEY}`). Body: `{query,
  max_results: 5, search_depth: "basic"}`. Returns
  `{results: [{title, url, content}, ...]}`.
- Fallback: Brave (`https://api.search.brave.com/res/v1/web/search`,
  header `X-Subscription-Token: ${BRAVE_API_KEY}`). Mapping
  `web.results[]` → `{title, url, snippet=description}`.
- Failure: throw if both keys absent. Caller emits error event,
  agent loop sees tool_result с error message.

**`visit_webpage`**
- `fetch(url, {redirect: 'follow', signal: AbortSignal.timeout(15000)})`.
- Extract: try `@mozilla/readability` parsing (npm package), иначе
  `cheerio` strip `<script>/<style>` + concatenate `<p>/<h*>` text.
- Truncate to 50000 chars (≈ 12.5K tokens) — token-control invariant.
  Truncation marker: `\n\n[... truncated, original length: <N> chars]`.

**`text_editor`**
- Read-only. `{path}` resolved against task workspace dir
  `/tmp/gaia-task-<uuid>/` (created per-task via `runGaiaTask`).
- Path-traversal guard: `path.resolve(workspaceDir, input.path)` must
  start с `workspaceDir`. Otherwise throw.
- Cap: 100KB read. Larger files → truncate + marker.
- **No write/edit** — упрощение Medium scope. GAIA tasks которые
  требуют write (rare in n=30) могут failed; documented в audit.

**`python_exec`**
- `child_process.spawn('python3', ['-c', code], { cwd: workspaceDir,
  env: { PATH: process.env.PATH }, timeout: 30000 })`.
- Restricted env: **только** `PATH` пропускается. NO `OPENAI_API_KEY`,
  `TAVILY_API_KEY`, `HF_TOKEN`, и т.д. — minimal blast radius если
  actor попытается exfiltrate.
- Capture stdout/stderr separately; `exit_code` ≠ 0 не throws (passed
  to agent как tool_result; let actor decide retry).
- **NOT sandboxed Docker** — это **Medium-scope deliberate decision**.
  Caveat: AHC harness не предназначен для adversarial code; assumed
  trusted actor (we're testing AHC, не security boundary). Upgrade
  path: swap к `firejail` / `bubblewrap` / Docker если security review
  потребует.

**`describe_image`**
- Calls vision-capable model via OpenRouter (gpt-5.4-mini поддерживает
  image input — verified `decisions.md 2026-05-13 D4 vision-capable
  LLMClient`).
- Message shape: `[{role: 'user', content: [{type: 'text', text: question},
  {type: 'image_url', image_url: {url: 'data:image/png;base64,<b64>'}}]}]`.
- 1 image per call; multiple images requires multiple tool calls (forces
  cost-awareness в agent loop).

### 4.3 Failure modes / fallbacks

- **Tool errors as tool_results, не exceptions** — AI SDK v6 native
  pattern: thrown errors в `execute` callback returned as tool_result
  с `{error: "..."}`. Agent видит и может retry/route around. **Hard
  exceptions** только если impl bug (TS error / null deref).
- **Tool API quota / rate limit** — propagated as tool_result error.
  Agent may stop или retry на different tool. Logged в run errors[].
- **`python_exec` timeout** — child process killed at 30s; tool_result
  `{stdout: <partial>, stderr: "TIMEOUT", exit_code: -1}`. Agent sees
  partial output, может adjust code.

### 4.4 Каждый tool — TDD seed

Per tool:
- **Unit (mocked)**: `vi.mock('node:fetch')` / `vi.mock('node:child_process')`
  / `vi.mock('node:fs/promises')`. Test happy path + error path.
- **Live smoke (gated)**: `const liveDescribe = process.env.TAVILY_API_KEY
  ? describe : describe.skip`. 1 real call, assert non-empty output.

---

## 5. Agent runner (`runGaiaTask`)

### 5.1 Contract + flow

Mirror `tau-bench-retail/agent-runner.ts:78-210` shape, **NO user-sim**:

```typescript
async function runGaiaTask(
  task: GaiaTask,
  deps: RunGaiaTaskDeps
): Promise<GaiaTaskResult> {
  const workspaceDir = `/tmp/gaia-task-${randomUUID()}/`
  await mkdir(workspaceDir, { recursive: true })
  try {
    const tools = wireGaiaTools(deps.tools, workspaceDir)
    const userMessage = renderGaiaPrompt(task)
    const result = await generateText({
      model: deps.actorModel,
      system: deps.actorSystem ?? GAIA_DRIVER_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      tools,
      stopWhen: stepCountIs(deps.maxSteps ?? 20),
      temperature: 0,
      experimental_telemetry: { isEnabled: true, functionId: 'gaia.task' }
    })
    return {
      response: result.text,
      n_steps: result.steps.length,
      n_tool_calls: result.steps.reduce((s, st) => s + st.toolCalls.length, 0),
      cost_usd: costFromUsageWithCache(deps.actorModelId, result.totalUsage),
      totals: { input: result.totalUsage.inputTokens, output: result.totalUsage.outputTokens },
      events: [],  // GAIA не emit'ит instrumentation events sам — AHC middleware bubbles если wrapped
      errors: []
    }
  } catch (err) {
    return { /* errors[] populated, partial result */ }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}
```

**Default `maxSteps=20`**. Holosophus uses 150 на librarian — но
gpt-5.4-mini на n=30 × 150 steps × ~$0.05/step = $225 max → слишком
дорого. 20 — realistic floor для multi-step research tasks; log если
cap fires в `errors[]` с `kind: 'max_steps_reached'`.

### 5.2 Dispatch в `runner.ts` — open question

**Текущий contract** `Baseline.step` (`src/eval/baseline.ts`) принимает
`Conversation` и возвращает text-only response. Tools-loop живёт **поверх**
baseline в случае `tau-bench-retail-med` через отдельный
`makeTauBenchAgentRunner(config)` factory — не через `buildRunnerFromBaseline`.

GAIA — agentic loop, тот же pattern что tau:
1. **Option A**: создать `makeGaiaBenchRunner(config)` factory parallel
   `makeTauBenchAgentRunner`. Все baselines × `gaia-med` идут через эту
   factory (тот же `runGaiaTask`, baseline determines compaction
   wrapping — `full_context` direct, `ahc_full` wrapped middleware).
2. **Option B**: расширить `Baseline.step` contract на tools-aware
   variant. Slower change, breaks existing baselines, не нужно для
   tau (которая работает без этого).

**Решение**: Option A — mirror tau pattern. Дешевле, минимальная
diffusion. `runner.ts` dispatch:

```typescript
if (config.baseline === 'mastra-agent') {
  // Already handled — internal bench-aware dispatch in I-track factory.
}
if (bench === 'gaia-med') {
  return makeGaiaBenchRunner(config)  // routes to runGaiaTask с
                                        // appropriate actor (FC raw,
                                        // AHC wrapped, etc.)
}
```

`makeGaiaBenchRunner` resolves baseline string → actor model wrapper
(`full_context` → bare OpenRouter, `ahc_full` → wrapLanguageModel +
createAhcMiddleware), затем вызывает `runGaiaTask`. См.
`tau-bench-retail/index.ts:makeTauBenchAgentRunner` как template.

**Mastra Agent** (Track I) `mastra-agent` baseline на bench=`gaia-med`?
**Out of K scope** — Track I shipped только с retail dispatch. Если в
K4 audit'е захочется cross-bench mastra-agent сравнение — отдельный
follow-up в Track I-tail.

### 5.3 Failure modes

- **No "Final answer:" в response.text** — grader fallback на full text
  normalized. Logged в audit как fallback rate per level.
- **Tool failures cascading** — agent loop может уйти в degenerate
  cycle (retry same failing tool). `stopWhen: stepCountIs(20)` гарантирует
  bounded cost.
- **`workspaceDir` cleanup failure** — `rm` с `force: true`, swallows
  errors. Worst case: temp files остаются в `/tmp/` (system cleanup
  на reboot).

---

## 6. Acceptance gates

### 6.1 Per-phase gates

**K1** (bench scaffold):
- 5 grader unit tests зелёные (numeric/list/text/mismatch/missing-Final).
- `bake-gaia.ts` idempotent: повторный запуск — same baked files (mtime
  reset допустим).
- `loadTasks(42)` returns ≥23 records (effective n after attachment
  filter).
- `references/gaia/data/gaia_validation_30.json` vendored + LICENSE
  note in `references/gaia/README.md`.

**K2** (tools):
- Per tool: unit (mocked) + 1 live-gated smoke зелёные.
- `web_search` returns ≥1 result on real query.
- `python_exec` timeout fires в expected 30s (assert wall-clock через
  test fixture, не just `exit_code === -1`).
- `describe_image` returns non-empty description на test image.

**K3** (runner + dispatch):
- Live smoke 1 level-1 task end-to-end: response не empty, contains
  "Final answer:" prefix (allows fallback path), `n_tool_calls ≥ 1`.
- `score.primary` ∈ {0, 1.0} (binary, no NaN).
- No exception в end-to-end path.
- `runner.ts` dispatch для bench=`gaia-med` × baseline=`full_context`
  работает (smoke test).

**K4** (sweep + audit):
- `summary.status === 'complete'` на cell.
- `err_rate === 0%` (если halt fires — split sweep как Track I делал).
- Per-level accuracy на level-1 ≥30% (sanity lower-bound для
  gpt-5.4-mini — Holosophus reports 60% на 10q sample).
- Audit doc citирует per-level numbers + per-tool usage + cache rate +
  caveats.

### 6.2 Track-level gate

- `./scripts/verify.sh all` зелёный после каждой фазы.
- Per-level numbers + per-tool usage + cache rate + caveats записаны в
  `docs/runs/baselines_frozen.md` gaia-med section (К-tail-2 finalized).
- `docs/benchmarks.md` получает §5 GAIA entry с реальными numbers (не
  forward-looking).

### 6.3 Freeze conditions

Аналогично Track I — competitor numbers freeze'ятся в `baselines_frozen.md`
после K4 если:
- Tool API surface stable (Tavily endpoint + auth pattern не меняются
  между K2 и K4).
- Mastra dependency pinned (если mastra-agent × gaia-med прогоняется).
- bake-script idempotent: hash baked tasks между runs identical.

Re-freeze trigger: bump tool API version, замена normalization rules
(supersedes upstream Holosophus), смена subset size.

---

## 7. Открытые вопросы

- **Q1 — Sandbox для `python_exec`**: subprocess + timeout + restricted
  env достаточно для research-use? Если AHC trajectories попадают в
  paper (publish dataset), нужно ли Docker isolation? **Текущее
  решение**: subprocess в K2; upgrade путь свободен (`firejail` или
  Docker swap). Revisit к K4 audit если security review просит.

- **Q2 — Bench id naming**: `gaia` vs `gaia-med`? Existing convention
  `lme-med` / `locomo-med` / `tau-bench-retail-med` для curated subsets
  с потенциальным full-split sibling. **Решение**: `gaia-med` (n=30
  stratified subset). Если K4 audit показывает что n=30 даёт enough
  discrimination — `gaia-full` (n=165) можно добавить как K5.

- **Q3 — List grader ordering: strict vs set-equality?** Holosophus
  делает strict-position. На GAIA validation answers с list форматом
  ("zip codes separated by commas") — ordering implicit. **Решение**:
  port verbatim (strict). Если K4 audit shows что 1-2 tasks fail
  только из-за ordering — separate decisions.md entry с rationale.

- **Q4 — Tool API ключи в CI**: Tavily/Brave/vision models — все
  paid. Local dev OK, но CI runs (`pnpm exec vitest run`) не должны
  hit external APIs. **Решение**: live tests gated по
  `describe = process.env.TAVILY_API_KEY ? describe : describe.skip`;
  CI skip'ает live smokes (как I track делает).

- **Q5 — Multimodal coverage**: skip xlsx/pdf — фильтруется ~5-7 из
  30 tasks. Effective n ≈ 23-26. **Решение**: deferred; xlsx/pdf
  parsers — отдельный K-tail если F-report попросит.

- **Q6 — Cross-paper accuracy comparability**: наши numbers сравнимы
  с Holosophus / upstream GAIA paper только при идентичной
  normalization + system prompt. System prompt верстуем verbatim
  (§4 attachments-rendering); normalization верстуем verbatim
  (§3.2). **Decision**: cite upstream numbers в F-report как «target
  ballpark»; primary comparison остаётся cross-baseline на одинаковом
  setup.

- **Q7 — `mastra-agent` × `gaia-med` integration**: Track I shipped
  Mastra-agent с `tau-bench-retail-med` dispatch hardcoded. GAIA
  integration — Track I-tail или K4 scope? **Текущее решение**:
  K4 scope включает только AI SDK baselines (full_context, ahc_full,
  возможно anthropic_compact). Mastra-agent × gaia — deferred (если
  F-report попросит cross-framework на GAIA, опускаем в follow-up).

---

## 8. Инварианты

### 8.1 Cache invariance (downstream invariant)

GAIA — agentic loop с tool calls; system prompt + first user message
stable. AHC middleware integration в K3 dispatch should not break
cache prefix invariant — но live cache rate ожидается **низкий**
(observed на tau: 0%) потому что multi-tool alternation injects
tool_result content в context, breaking prefix stability between
turns.

**Manual check** в K4 audit: log `cache_read` per record; expected
range 0-20% для AHC variants. Если выше — investigate (что-то
интересное про how AHC compaction stabilizes prefix даже под
tool-call churn).

### 8.2 Bench-shape invariant: `score.primary ∈ {0, 1}`

GAIA — binary correctness, не 3-level (AT) / yes-no (LME). **Test**:
`createGaiaGrader` unit test проверяет что выход score.primary
строго `0.0` или `1.0`, no intermediate values.

### 8.3 Effective-n stability between bake runs

`scripts/bake-gaia.ts` idempotent: один и тот же input snapshot →
identical baked files (modulo mtime). Effective n (post-attachment
filter) фиксируется в K1 audit one-shot; стабильность под `pnpm tsx
scripts/bake-gaia.ts ...` re-runs.

**Test**: shasum обоих runs одинаковы.
