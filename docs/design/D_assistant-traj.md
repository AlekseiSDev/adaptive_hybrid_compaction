# Track D Design — AssistantTraj Benchmark

> Track-level design для кастомного multimodal ассистентского benchmark.
> Phase plan — `system_design §7.2 Track D` (D1 schema → D2 real traces → D3 synthetic top-up → D4 judge).
> Eval-strategy framing — `system_design §6.3`.

---

## Meta

- **Track:** D (D1–D4, 10 дней wall-clock)
- **Зависит от:** ничего внутри проекта (старт day 1)
- **Блокирует:** E1 (нужен полный AssistantTraj для main sweep)
- **Owner:** Aleksei (real traces source); harness construction — agent

---

## 1. Scope

- **In**: task JSON schema, source pipeline, anonymization protocol, judge rubric format,
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
real production traces (Aleksei)  ──┐
                                    ├──► anonymization ──► manual review ──► tasks/
opensource benches (filtered)     ──┤    + format conv     + 100% signoff
                                    │
synthetic generation (Sonnet)     ──┘
```

### 3.1 Real traces (D2)

- Source: 2D-canvas production sessions, отобранные Aleksei.
- **Anonymization checklist (см. §4) обязателен ДО format-conversion'а.**
- Target: ~15–20 tasks (50–60% всех).

### 3.2 Open-source (D2, parallel)

- Поиск multimodal assistant benches с free license, fit'ящих medium-traj (5–15 turns).
- Кандидаты для review (verify при D2):
  - VisualWebArena medium-filter subset
  - AssistBench (если есть medium tasks)
- Target: ~5–10 tasks. Decision к D2 mid.

### 3.3 Synthetic top-up (D3)

- Trigger: real + opensource < 30 — догенерация через `claude-sonnet-4-6`.
- Prompts разнообразные, темплейт-варьирование, не один шаблон per category.
- **100% manual review** каждой synthetic трассы (5–10 мин/task). Non-negotiable.
- Synthetic не маркируется как `real` в `source` поле — честность для Discussion.

---

## 4. Anonymization protocol (real traces only)

Обязательное удаление / маскирование ДО включения в benchmark:

| Тип | Action | Notes |
|---|---|---|
| User identifiers (имя, email, user_id) | Replace `<USER_A>`, `<USER_B>` | Pseudonyms consistent within task |
| Project names / company names | Replace placeholders | Generic если бизнес-логика не зависит; fake plausible если зависит |
| API keys, tokens, URLs с auth | Strip целиком → `<REDACTED_API_KEY>` | Never preserve |
| Email addresses, phone | `<EMAIL>`, `<PHONE>` | |
| Image faces / документы | Blur / редизайн в attachment | Manual; не automated |
| Internal file paths | Generic (e.g. `/path/to/project/`) | |
| Дата/время | Относительно task start, не абсолют | Preserve relative ordering |

После anonymization — manual audit pass (Aleksei). `provenance.anonymized_at` ставится
обязательно. Без этого поля task не grader'ится — fail loud.

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

## Open questions

1. VisualWebArena как open-source source — fit'ит ли по domain (browser tasks vs general
   assistant)? Решение — D2 mid (после поиска).
2. Rubric гранулярность — three-level (0/0.5/1) или continuous (0–10)? Default —
   three-level (less judge noise). Revisit после первых 10 trial scores в D4.
3. Image attachments — base64 inline или path reference в task JSON? Default —
   path reference (task JSON остаётся читаемым), inline только в Conversation при run-time.
4. Code-iter category — нужен ли real code executor (sandbox)? Default — нет, regex
   на patterns + judge на intent; full execution = scope creep.
