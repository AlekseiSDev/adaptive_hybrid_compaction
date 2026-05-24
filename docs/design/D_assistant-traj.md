# Track D Design — AssistantTraj Benchmark + Bench Ports

> Track-level design для кастомного multimodal ассистентского benchmark
> (D1–D4) + порт остальных трёх бенчей из `references/mle-harness/` (D5).
> Phase plan — `system_design §7.2 Track D` (D1 schema → D2 real traces →
> D3 synthetic top-up → D4 judge → D5 bench-ports).
> Eval-strategy framing — `system_design §6.3`.

---

## Meta

- **Track:** D (D1 schema → D2 real traces → D3 synthetic top-up → D4 judge → D5 bench-ports)
- **Wall-clock:** 10 дней (D1–D4) + 3 дня (D5)
- **Зависит от:** ничего внутри проекта (старт day 1); D5 дополнительно зависит от B1 (eval harness)
- **Блокирует:** E1 — AssistantTraj-only smoke возможен после D4; полный 4-bench sweep ждёт D5
- **Owner:** Aleksei (real traces source); harness construction — agent
- **Связь:** `system_design §6.3` (eval-strategy для multimodal), `design/B_eval-harness.md` (RunRecord / NDJSON shape — D4 eval adapter эмитит в общий harness), `references/mle-harness/code/run_{longmemeval,locomo,taubench}.py` (Python sources to port в D5)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе.

### Track D (после D4) — AssistantTraj closed

**Доступно:**
- `benchmarks/assistant_traj/tasks/*.json` — 30–40 multimodal заданий, conform к
  `Task` JSON schema (§2), распределённых по target quotas (§1.1).
- `benchmarks/assistant_traj/rubrics/<category>.md` — judge rubric per category (§6).
- `eval/adapters/assistant-traj.ts` — eval dispatch (§5) + judge integration (§6.2 cache).
- Доступно через harness как `bench: assistant_traj` в sweep YAML (Track E consume'ит partial AssistantTraj-only sweep).

**Demo (e2e):** `pnpm tsx benchmarks/assistant_traj/validate.ts` — schema-validate
всех task'ов; затем `pnpm tsx benchmarks/assistant_traj/judge.ts --task at_image_qa_001`
прогоняет judge на одной human-labeled task'е и печатает `{score, justification,
human_delta}`. Оба скрипта создаются в D1 / D4 как обязательные exit artifacts.

**Acceptance gate:** schema validator зелёный на 100% tasks + judge calibration
`|human - judge| ≤ 0.5` на ≥ 70% human-labeled subset (D §6.1, exit criterion D4).

### Track D (после D5) — full 4-bench corpus

**Доступно (в дополнение к D4):**
- `src/eval/adapters/{longmemeval,locomo,tau-bench}.ts` — TS BenchAdapter +
  grader per bench, портированные из `references/mle-harness/code/run_*.py`.
- `benchmarks/{longmemeval,locomo,tau-bench}/` — per-bench task fixtures
  (loader-ready layout, mirror of upstream).
- Sweep YAML может ссылаться на все 4 бенча; `bench:` literal union в
  `src/eval/types.ts` все 4 уже содержит — D5 поднимает их с placeholder до
  реальной загрузки.

**Demo (e2e):** `pnpm tsx scripts/eval.ts --sweep <yaml referencing all 4 benches>`
запускает один task per bench через synthetic baseline — все 4 валидно
проходят load → prepare → grade.

**Acceptance gate (D5):** per-bench validator зелёный + 1-task smoke
прогоняется на каждом из 3 ported бенчей (AssistantTraj smoke уже из D4).
**Минимальная beta floor** (`system_design §9`): 3 бенча = AssistantTraj + 2
из {LongMemEval, LoCoMo, tau-bench}. Полные 4 — stretch goal.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **D1** | `Task` JSON schema (§2) + storage layout (§7) зафиксированы; `benchmarks/assistant_traj/validate.ts` (создаётся в D1) round-trip'ит valid/invalid fixtures | `pnpm tsx benchmarks/assistant_traj/validate.ts --fixtures` + `./scripts/verify.sh test:unit` |
| **D2** | jay-canvas-seeded traces в `tasks/` (≥15 шт), conform к schema, hand-extended до medium-traj 5–15 turns (OSS bench addition deferred — см. `decisions.md [2026-05-13] D2 OSS deferred`) | `pnpm tsx benchmarks/assistant_traj/validate.ts` (schema green over all `tasks/*.json`) |
| **D3** | Synthetic top-up в `tasks/` (запускается только если `real + oss < 30`); 100% manual-review checklist (Aleksei sign-off в `provenance.review_signoff`) | `pnpm tsx benchmarks/assistant_traj/validate.ts` (schema green на synthetic) + **human gate**: каждая synthetic task имеет non-empty `review_signoff` (grep check) |
| **D4** | `eval/adapters/assistant-traj.ts` + `benchmarks/assistant_traj/judge.ts` работают; `calibration/human_scores.json` с 10% sample; calibration κ достигнут | `pnpm tsx benchmarks/assistant_traj/judge.ts --calibrate` (выводит κ vs target из §6.1) + `./scripts/verify.sh` |
| **D5** | `src/eval/adapters/{longmemeval,locomo,tau-bench}.ts` + per-bench grader; `benchmarks/<bench>/` task fixtures portированы из `references/mle-harness/`; 1-task smoke на каждом из 3 ported бенчей через `runSweep` | `pnpm tsx scripts/eval.ts --sweep <smoke yaml with all 4 benches, 1 task each>` (exit 0; per-bench `RunRecord` with `score.primary` non-null) + per-bench `validate.ts` зелёный |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track D`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы/схемы, которые трогает или вводит фаза (для D — task JSON schema из §2 и storage layout из §7).
- **TDD seed** — failing test, с которого фаза стартует (Red в TDD-цикле).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **D1** AssistantTraj design + JSON schema | — | D2, D3, D4 | §1, §1.1, §2, §7 | `Task` JSON schema (§2), storage layout (§7) | schema validator round-trip: valid task проходит, missing required field — fail | §5 eval dispatch (skeleton полей для category/modality) |
| **D2** Сбор jay-canvas-seeded трасс (+ OSS optional follow-up) | D1 | D4 | §3.1 (§3.2 — follow-up) | conformance к `Task` schema из §2 | validator green over ≥15 conformant `tasks/*.json`, hand-extended до 5–15 turns | §1.1 target distribution (учёт квот при отборе), §7 storage layout |
| **D3** Synthetic top-up + manual review | D1 (conditional: запускается если `real + oss < 30`) | D4 | §3.3, §1.1 | conformance к `Task` schema; пометка `source: synthetic` | synthetic task проходит тот же schema-validator + manual-review checklist (100% review gate) | §3.1/§3.2 (что именно недобрали), §6 rubric (synthetic не должен ломать judge) |
| **D4** Eval adapter + LLM-judge rubrics | D1, D2, D3 | E1 (AssistantTraj-only), D5 | §5, §6, §6.1, §6.2 | judge prompt template (§6), rubric scoring contract (1.0 / 0.5 / 0.0) | judge calibration: на 10% human-labeled subset Cohen's κ ≥ target из §6.1 | §6.2 judge cache (детерминизм/повтор прогонов), §7 storage (запись judge outputs) |
| **D5** Other-bench ports (LongMemEval / LoCoMo / tau-bench) | D1 (Task/Score contract), D4 (Score extension с judge_cost_usd / judge_explanation), B1 (eval harness) | E1 (full 4-bench sweep) | §8 (D5 preview); `references/mle-harness/code/run_{longmemeval,locomo,taubench}.py` (upstream sources) | `BenchAdapter` из `src/eval/types.ts`; per-bench `Grader`; bench-specific task layouts под `benchmarks/<bench>/` | per-bench loader round-trips upstream task в schema'd `Task` shape + grader даёт score на known input | §5 dispatch (per-bench strategy: tau-bench tool-grounded; longmemeval recall Q&A; locomo dialog continuation), `system_design §9` fallback floor 3 |

**Parallelization:** `D1` — first, нет deps; `D2/D3` параллельны после `D1` (D2 — jay-canvas-seeded collection; OSS — optional follow-up; D3 — synthetic top-up), результаты merge'атся перед D4; `D4` закрывает AssistantTraj; `D5` стартует после D4 (зависит от Score-shape extension) и закрывает Track D.

**Orthogonal / deferred:**
- §4 Anonymization protocol — **superseded** by `decisions.md [2026-05-13] §4 dropped`. D2 sources confirmed synthetic (jay-canvas e2e golden-set + OSS benches); no real-user data path. `provenance.anonymized_at` cross-field rule kept in schema as defensive code.
- §6.2 Judge cache — не блокирует D4 MVP, но нужен для повторных прогонов в Track E (стабильность стоимости).
- §1.1 Target distribution — baseline, читаем при D1, перечитываем если D2 недобирает квоту и активируется D3.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Scope

- **In**: task JSON schema, source pipeline, judge rubric format,
  storage layout, eval-dispatch logic.
- **Out**: training data, model fine-tuning, multimodal preprocessing internals
  (тонко в `eval/adapters/assistant-traj.ts`).

### 1.1 Target distribution

| Category | Tasks | Source priority |
|---|---|---|
| Image-grounded Q&A | 8 | real → open-source → synthetic |
| Code generation + iteration | 8 | real → synthetic |
| Research-then-write | 8 | real → open-source → synthetic |
| Mixed assistant flow | 6–16 | real → synthetic |

Total: 30–40 tasks. Minimum size 30 (fallback из `system_design §9`).

---

## 2. Task JSON schema

```typescript
type AssistantTrajTask = {
  task_id: string                       // 'at_<category>_<nnn>'
  category: 'image_qa' | 'code_iter' | 'research_write' | 'mixed'
  source: 'real' | 'opensource' | 'synthetic'

  turns: TaskTurn[]                     // Multi-turn conversation skeleton
  tools_available: ToolDefinition[]     // What agent has access to

  evaluation: EvaluationSpec            // Dispatch для grader

  provenance: {
    anonymized_at?: string              // ISO date; required if source === 'real'
    anonymization_steps?: string[]      // checklist items applied
    original_session_hash?: string      // dedup only; не reverse-link
    review_signoff?: string             // who reviewed (Aleksei initials + date)
  }
}

type TaskTurn = {
  role: 'user' | 'assistant' | 'tool'
  content: ContentPart[]                // multimodal — text/image/file/tool_use/tool_result
  expected_tool_calls?: ToolCallExpectation[]   // для code_iter, research_write
}

type EvaluationSpec =
  | { strategy: 'exact_match'; expected: string; case_sensitive?: boolean }
  | { strategy: 'regex'; pattern: string; flags?: string }
  | { strategy: 'llm_judge'; rubric_id: string; expected_summary: string }
  | { strategy: 'composite'; rules: EvaluationSpec[]; aggregate: 'all' | 'any' | 'mean' }

type ToolCallExpectation = {
  tool_name: string
  required?: boolean                    // must be called for full credit
  args_match?: 'exact' | 'subset' | 'semantic'
}
```

Storage: один JSON file per task — `benchmarks/assistant_traj/tasks/at_<cat>_<id>.json`.
Attachments (images, files) — рядом в `attachments/at_<cat>_<id>/`, referenced by path.

---

## 3. Source pipeline

```
jay-canvas golden-set scenarios   ──┐
                                    ├──► format-conv ──► hand-extend ──► manual review ──► tasks/
opensource benches (filtered)     ──┤    (importer)    to 5–15 turns    + signoff
                                    │
synthetic generation (Sonnet)     ──┘
```

### 3.1 jay-canvas seeded traces (D2)

- Source: `/Users/Aleksei/Projects/jay-canvas/apps/platform/api/e2e/golden-set/scenarios/`
  — 12 JSON files, ~80 scenarios across single-letter categories
  (A/AM/CD/DBG/ED/IE/IG/MUS/MX/QA/VG/WC). Confirmed synthetic test fixtures —
  no real-user PII. `source='opensource'` in our schema (Aleksei's other open
  project, not real production users).
- **Format-conversion via `scripts/import-jay-canvas.ts`** — projects jay-canvas
  scenarios into `AssistantTrajTask` skeletons. See implementation in
  `src/eval/adapters/assistant-traj.import.ts`.
- **Hand-extension to 5–15 turns**: jay-canvas scenarios are typically 1–2 turns;
  agent + Aleksei handcraft 3–13 additional turns to reach medium-traj range,
  preserving the task arc (follow-ups, refinements, tool loops, image follow-ups).
- **Image attachments** downloaded locally to `attachments/<task_id>/` —
  no remote URL references in committed task JSON (jay-canvas test CDN may rot).
- **Manual review signoff** — `provenance.review_signoff` = Aleksei initials + ISO
  date once each hand-extended task is reviewed.
- Target: ≥15 tasks (≥4 per primary AHC category from §1.1: image_qa, code_iter,
  research_write; ≥3 mixed). Remaining quota fills via OSS (§3.2) and D3 synthetic.

### 3.2 Open-source (deferred — additive follow-up)

**Status:** deferred to a follow-up PR. D2 closed on jay-canvas-only yield (≥15 tasks),
which meets §1.1 category floors without OSS. See
`decisions.md [2026-05-13] D2 OSS deferred` for the survey + rationale.

Strongest candidates (for the follow-up PR):
- **MMDU** — 421 images, 1645 Q&A pairs, ~15 turns each. Best medium-traj fit per arxiv.org/abs/2406.11833.
- **MMCR** — 310k contextual dialogues, 4–8 turns each (arxiv.org/html/2503.18533v1).
- VisualWebArena medium-filter subset, AssistBench — historical candidates from D1 plan, lower priority.

License + format due-diligence + per-source importer required before adding. If D3
synthetic top-up + jay-canvas total < 30, this OSS work re-prioritizes.

### 3.3 Synthetic top-up (D3)

- Trigger: real + opensource < 30 — догенерация через `claude-sonnet-4-6`.
- Prompts разнообразные, темплейт-варьирование, не один шаблон per category.
- **100% manual review** каждой synthetic трассы (5–10 мин/task). Non-negotiable.
- Synthetic не маркируется как `real` в `source` поле — честность для Discussion.

---

## 4. Anonymization protocol — superseded

**Status:** dropped 2026-05-13. See `docs/decisions.md [2026-05-13] §4 anonymization
dropped`. All D2 sources are synthetic test fixtures (jay-canvas e2e golden-set
+ OSS benches) — no real-user data ever enters `tasks/`. The
`provenance.anonymized_at` cross-field rule remains in `AssistantTrajTaskSchema`
as defensive code for any hypothetical future `source='real'` task; it stays
dormant in current scope.

---

## 5. Eval dispatch

```typescript
function evaluate(task: AssistantTrajTask, response: AgentResponse): Score {
  switch (task.evaluation.strategy) {
    case 'exact_match': return exactMatchScore(task.evaluation, response)
    case 'regex':       return regexScore(task.evaluation, response)
    case 'llm_judge':   return judgeScore(task, response, loadRubric(task.evaluation.rubric_id))
    case 'composite':   return compositeScore(task, response)
  }
}
```

Default strategy per category:
- `image_qa` → `llm_judge` (factual content varies, exact-match too brittle).
- `code_iter` → `composite` ([regex: код запускается на test cases, llm_judge: соответствует intent]).
- `research_write` → `llm_judge`.
- `mixed` → per-task decision; chosen at task construction time.

---

## 6. Judge rubric format

Один rubric per category в `benchmarks/assistant_traj/rubrics/<category>.md`:

```markdown
# Rubric: image_qa

## Score 1.0 (perfect)
- All factual claims about the image are correct
- Answers the user's specific question, не уходит в сторону
- Tone и detail level match assistant-style (не academic, не lengthy)

## Score 0.5 (partial)
- Most facts correct, minor inaccuracies on peripheral details
- Answers core question but misses sub-questions

## Score 0.0 (fail)
- Hallucinates major facts about image content
- Doesn't address the question
- Refuses without justified reason

## Judge prompt template
You are evaluating an assistant response to an image-grounded question.

Image: [attached]
User question: {question}
Expected key points: {expected_summary}
Assistant response: {response}

Output JSON: { "score": 0.0 | 0.5 | 1.0, "justification": "..." }
```

Judge model: `openai/gpt-5.4`. Temperature 0. Image passed inline (vision-capable).

### 6.1 Bias calibration (D4)

Sample 10% всех AssistantTraj задач для human verification:
1. Aleksei проставляет own score на sample (10% of tasks, sampled stratified per category).
2. Если `|human_score - judge_score| > 0.5` на > 30% sample — пересматриваем rubric
   до запуска E1.
3. Calibration scores хранятся в `calibration/human_scores.json` (post-hoc для отчёта).

### 6.2 Judge cache

Judge calls deterministic (temp=0), но всё равно платные. Cache hit'ы: при retry'е
того же `(task_id, response_hash)` использовать cached score. Реализация — простой
JSON file `benchmarks/assistant_traj/judge_cache.json`, key = `sha256(task_id + response)`.

---

## 7. Storage layout

```
benchmarks/assistant_traj/
  tasks/
    at_image_qa_001.json
    at_code_iter_001.json
    ...
  attachments/
    at_image_qa_001/
      input_image.png
      followup_image.jpg
  rubrics/
    image_qa.md
    code_iter.md
    research_write.md
    mixed.md
  calibration/
    human_scores.json           # 10% sample, для D4 bias check
  judge_cache.json              # see §6.2
  README.md                     # quick start: схема, как добавить task
```

---

## 8. D5 — Other-bench ports (preview)

Phase D5 расширяет Track D с одного бенча (AssistantTraj) до полных четырёх,
портируя оставшиеся три из vendored Python harness'а в TS-адаптеры под общий
`BenchAdapter` контракт.

**Scope:**
- `src/eval/adapters/longmemeval.ts` — long-context memory eval (Q&A над
  историей разговоров). Источник: `references/mle-harness/code/run_longmemeval.py`
  (если есть; в worst case — official upstream dataset loader).
- `src/eval/adapters/locomo.ts` — long conversation memory (multi-session dialog
  continuation). Источник: `references/mle-harness/code/run_locomo.py`.
- `src/eval/adapters/tau-bench.ts` — task-based agentic eval (retail subset).
  Источник: `references/mle-harness/code/run_taubench.py`. Heaviest — agentic
  tooling + per-action state.
- Per-bench grader (отдельный от D4's AssistantTraj judge — разные scoring
  contracts: longmemeval exact-string recall, locomo semantic similarity,
  tau-bench task completion + tool-call sequence).
- Bench-specific task layouts: `benchmarks/{longmemeval,locomo,tau-bench}/tasks/`.
- Регистрация в `defaultAdapterRegistry.resolve` в `src/eval/runner.ts` (3
  новых case'a).

**Out of D5 scope:** AHC middleware tuning against new benches (Track E1/E2),
optimization of per-bench prompt-cache patterns (deferred — E3 covers cache
rate subset).

**Minimum viable выход (per `system_design §9`):** AssistantTraj + 2 ported
benches = 3-bench floor для beta. Полные 4 — stretch goal. ~~Если tau-bench
порт оказывается дороже 1 дня (agentic complexity), его допустимо отложить и
закрыть D5 на 3 бенчах.~~ **Status (2026-05-13): closed на full 4-bench
corpus.** Tau-bench shipped через AI SDK v6 native engine (см.
`docs/decisions.md` D5 entries) — не custom ReACT loop, что съело меньше
wall-clock чем планировалось. AHC integration в tau-bench Runner также
wired в D5 (не deferred к E1) per user pushback.

**TDD entry (D5 start):** для каждого из 3 бенчей — failing test, который
импортирует 1 upstream task → проектирует в `Task` shape → grader выдаёт
score на known-good response. Green = full per-bench round-trip.

---

## 9. Bench role in AHC eval — compaction-axis framing

Все 4 бенча Track D — **compaction benchmarks** разных eval axes. AHC оценивается
не как «agent loop framework», а как **policy под compaction quality** — и каждый
бенч изолирует разный compaction failure mode:

| Bench | Eval axis | Shape | Failure mode tested |
|---|---|---|---|
| **AssistantTraj-v2** | trajectory coherence + tool-call coherence | multi-turn replay assistant trace **with mocked tools** (`image_gen`, `google_search`, `web_fetch`, `code_interpreter`); fixture-replay default | trajectory drift + **required tool-call drop** под compaction. **Stateless replay** (нет env-state, нет write-actions) — отличие от τ-bench. AT-v2 = "помнит ли агент что нужный tool *надо вызвать*", τ-bench = "корректное env-state mutation". См. `docs/design/J_at_tools.md`. |
| **LongMemEval-med** | passive recall | 1-turn QA над ~16k history | fact loss из compaction |
| **LoCoMo-med** | passive recall (dialog) | 1-turn QA над multi-session dialog | long-range reference / temporal anchor loss |
| **τ-bench-retail-med** | agentic state | live tool loop + user-sim + env state | env-state knowledge loss + tool coherence через compaction |

**Upstream Python harness precedent.** `references/mle-harness/code/run_main.py:99-153`
(LME) и `run_locomo.py` гонят те же бенчи именно как compaction quality eval:

```
history (long, ~16k tokens) →
  STRATEGIES[strategy](history, question, budget) →
  driver_answer(compacted_segments, question) →
  judge(response, ground_truth_answer)
```

`STRATEGIES` = full_context / naive_truncation / rolling_summary / type_aware /
task_aware. Accuracy под compaction — это и есть метрика. Single-turn QA shape
бенча тут абсолютно валиден потому что *long input* — сам по себе compaction
stress-test (recall-axis). AHC adaptive classifier добавит per-trajectory routing
поверх этой pipeline'ы.

Per `system_design §1.3` предварительные гипотезы (см. также §6.2):
- **Task-aware** дома на passive-recall axis (LME / LoCoMo).
- **Type-aware** дома на agentic-state axis (τ-bench).
- **AHC adaptive classifier** маршрутизирует per-trajectory — это и есть value
  proposition vs single-policy baselines.

Без LME / LoCoMo не имеем сигнала на recall-axis (passive history compaction);
без τ-bench не имеем сигнала на live tool loop под compaction. Все 4 — не
дублируются.

**Adapter contract implication.** `BenchAdapter.prepare(task)` возвращает
**FULL long history** в `Conversation.messages` — без compaction. Compaction
живёт на baseline layer:

- `full_context` baseline (existing) — passthrough; служит pessimistic upper-bound
  baseline; на длинных историях рискует hit'нуть LLM context limit.
- `ahc_core` baseline (existing в B5, AHC integration в E1+) — wraps actor через
  `wrapLanguageModel({middleware: createAhcMiddleware(...)})` для adaptive
  compaction перед каждым `generateText` call. Same shape для всех 4 бенчей —
  adapter не знает что baseline сделает с input.

Тауau-bench специфика: compaction живёт *внутри* agentic loop (между actor steps),
не как pre-process одного call'a — AHC middleware применяется per-step через
`wrapLanguageModel`, agentic loop AI SDK orchestrates the rest. См. D §8 для
detail'ов tau-bench engine'a.

---

## Open questions

1. VisualWebArena как open-source source — fit'ит ли по domain (browser tasks vs general
   assistant)? Решение — D2 mid (после поиска).
2. Rubric гранулярность — three-level (0/0.5/1) или continuous (0–10)? Default —
   three-level (less judge noise). Revisit после первых 10 trial scores в D4.
3. Image attachments — base64 inline или path reference в task JSON? Default —
   path reference (task JSON остаётся читаемым), inline только в Conversation при run-time.
4. Code-iter category — нужен ли real code executor (sandbox)? Default — нет, regex
   на patterns + judge на intent; full execution = scope creep.
