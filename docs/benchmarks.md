# Benchmarks (datasets reference)

Сводная справка по 5 датасетам, на которых гоняется AHC eval-harness.
Источник истины по дизайну — `docs/design/D_assistant-traj.md` (§9 — eval axes
и почему каждый bench выбран). Пятый bench `gaia-med` добавлен Track K
(`docs/design/K_gaia.md`, 2026-05-26). Этот файл — практический
справочник «что/где/как» без архитектурных рассуждений.

## Сводная таблица

| Bench | Адаптер | n | Turns | Tools | Ground truth | Скоринг | System prompt |
|---|---|---|---|---|---|---|---|
| AssistantTraj | `assistant-traj` | 30 | 3–13 (med 7) | 0–1 (replay) | rubric + `expected_summary` (prose) | LLM-judge 0 / 0.5 / 1.0 (+ composite: regex / exact_match) | custom — нет (replay) |
| LongMemEval-med | `longmemeval-med` | 120 | 1 (single-shot) | 0 | `answer` string, e.g. `"25"` | LLM-judge yes/no, 5 type-templates → 0/1 | ⚠ см. §2 caveat — `LME_DRIVER_SYSTEM` declared, но не wired; де-факто `DEFAULT_AGENT_SYSTEM_PROMPT` |
| LongMemEval-multiturn | `lme-multiturn` | 120 | 41–63 (med ~49) | 0 | тот же `answer` | тот же judge | тот же `DEFAULT_AGENT_SYSTEM_PROMPT` |
| LoCoMo-med | `locomo-med` | 25 | 1 (single-shot) | 0 | `answer` + `evidence[]` dia_ids | LLM-judge yes/no (single template) → 0/1 | provided (`LOCOMO_DRIVER_SYSTEM`) |
| τ-bench retail | `tau-bench-retail-med` | 30 | 1–30 live (типично 8–20) | 10 retail | `expected_end_state` (env diff: orders + users) | Deterministic — `calculateReward` → {0, 1} | provided + wrapped (retail wiki + `buildSystemPrompt`) |
| GAIA-med | `gaia-med` | 25 (eff) | 1 (single-shot, multi-step internal) | 5 GAIA | `answer` string | Pure-normalization exact-match → {0, 1} (no LLM judge) | provided (`GAIA_DRIVER_SYSTEM` verbatim Holosophus) |

Легенда колонок: `Turns` — количество driver calls per task (single-shot
= 1 call с историей в user-msg). `Tools` — кол-во tool definitions
доступных actor'у. `Ground truth` — формат правильного ответа в JSON
task'а. `System prompt`: `provided` = verbatim из upstream eval,
`custom` = наш, `provided + wrapped` = upstream policy внутри нашего
`buildSystemPrompt`. Детали примеров — в секциях ниже.

LLM-judge модель — `anthropic/claude-sonnet-4.6` (один судья на всех
text-benches). Cache — `benchmarks/<bench>/judge_cache.json`. System
prompt baselines видят 1-в-1 как AHC (fair-comparison invariant,
`src/core/prompts.ts` re-export в baselines).

---

## 1. AssistantTraj (AT)

### Название и роль

`assistant-traj` — самопальный multimodal bench, имитирующий настоящие
medium-trajectory диалоги (5–15 turns) ассистента с пользователем. Не
заимствуется у upstream, написан под AHC для трёх вещей одновременно:
изображения, code iteration, mixed tool use.

### Что покрывает

4 категории:
- **image_qa** (n=8) — пользователь шлёт картинку (SVG/PNG) + вопрос
  → ассистент отвечает текстом, multi-turn refinement.
- **code_iter** (n=8) — пользователь итеративно правит/расширяет код
  через несколько user turns.
- **research_write** (n=8) — длинные writing-задачи с поиском фактов.
- **mixed** (n=6) — комбинация tool calls + текст + изображения в одном
  трейсе.

Цель — поверхность для AHC integration testing: бывают и большие
tool_results (offloader активация), и длинные accumulated assistant
outputs (compaction quality).

### Где смотреть

- Данные: `benchmarks/assistant_traj/tasks/at_*.json` (30 файлов).
- Attachments: `benchmarks/assistant_traj/attachments/<task_id>/...`.
- Schema (Zod): `src/eval/adapters/assistant-traj.schema.ts`.
- Adapter: `src/eval/adapters/assistant-traj.ts`.
- Judge: `src/eval/adapters/assistant-traj.judge.ts`.
- Rubrics (3-level scoring criteria): `benchmarks/assistant_traj/rubrics/<category>.md`.
- Validator CLI: `pnpm tsx benchmarks/assistant_traj/validate.ts`.
- Design: `docs/design/D_assistant-traj.md` (полный design).

### Как скорится

Task carries `evaluation` block с одной из 4 strategies (Zod discriminated union):

- `exact_match` — точное совпадение строки.
- `regex` — `pattern + flags`, `RegExp.test(response)`.
- `llm_judge` — `rubric_id` (`image_qa` / `code_iter` / `research_write` /
  `mixed`) + `expected_summary`. Judge видит: rubric markdown + expected
  summary + полный assistant response + (для image_qa) attachments
  base64-encoded. Output — strict JSON `{ score: 0.0 | 0.5 | 1.0, justification }`,
  парсится `parseThreeLevelJson`.
- `composite` — массив `rules[]` любых strategies + `aggregate: 'all' | 'any' | 'majority'`.

3-level судья — выбор Track D: continuous-enough, чтобы поймать «почти
прав» (0.5), discrete-enough, чтобы был stable agreement между judge runs.

Score попадает в `Score.primary` ∈ [0, 1].

### Пара типичных семплов

**AT image_qa_001** (composite, regex + llm_judge):

User шлёт SVG-схему оплаты + просит визуализировать в Mermaid.
Несколько turn'ов уточнений (3DS retry, отмены, альтернативная карта).
В финале — собрать полную diagram.

```json
"evaluation": {
  "strategy": "composite",
  "aggregate": "all",
  "rules": [
    { "strategy": "regex",
      "pattern": "^```mermaid\\s*\\nflowchart\\s+TD\\b[\\s\\S]+?```\\s*$",
      "flags": "m" },
    { "strategy": "llm_judge", "rubric_id": "image_qa",
      "expected_summary": "Single Mermaid `flowchart TD` block covering ... " }
  ]
}
```

**AT code_iter_*** — несколько user turns: «напиши функцию X» → «теперь
учти edge case Y» → «оберни в класс». Judge сравнивает финальный код
против rubric «adresses all asks + compiles + handles edge cases».

### Tools

`tools_available[]` объявляется per-task в JSON, но AT — **replay
benchmark**: assistant turns уже записаны заранее, driver не делает
live tool execution. Распределение:

- 24/30 tasks: `tools_available = []` (purely conversational / vision).
- 6/30 tasks: `tools_available` ровно с 1 tool definition (in
  `at_code_iter_*` и `at_image_qa_*` — упомянутый в исходном трейсе тул,
  как декларация для compaction-context, не для активного вызова).

Live tool dispatch (а вместе с ним и offloader activation) на AT не
ожидается — bench нагружает primarily observer / tier rotation через
длинные assistant outputs + multimodal user inputs.

### System prompt

**Custom — нет dedicated system prompt.** `turns[]` уже содержит первый
user message как seed, assistant роли проигрываются заранее (replay).
Baselines подают `turns` напрямую через `adapter.prepare()` →
`Conversation { messages: [...] }`. AHC и не-AHC baselines одинаково.

---

## 2. LongMemEval (LME)

### Название и роль

LongMemEval (Wu et al., 2024 — `github.com/xiaowu0162/LongMemEval`, MIT).
В нашей терминологии — `longmemeval-med` (single-turn replay) и
`lme-multiturn` (multi-turn replay варианта Track H Phase 1). Один и тот
же baked subset, два разных `prepare()`.

### Что покрывает

Long-context memory: вопрос задан после многосессионного диалога
(~16k токенов истории, иногда больше). 6 question types:

| question_type | n (наш subset) | Что меряет |
|---|---|---|
| `temporal-reasoning` | 32 | временные отношения, off-by-one tolerant |
| `multi-session` | 32 | связи между сессиями |
| `knowledge-update` | 19 | предпочтение свежих фактов над устаревшими |
| `single-session-user` | 17 | факт из одной session, упомянутый user'ом |
| `single-session-assistant` | 13 | факт упомянутый assistant'ом |
| `single-session-preference` | 7 | personalization-style |

Frozen subset n=120 — `benchmarks/longmemeval/subset_ids.json`
(stratified, seed=42).

### Где смотреть

- Baked tasks: `benchmarks/longmemeval/tasks/lme_*.json` (120 + 3 smoke).
- Subset frozen: `benchmarks/longmemeval/subset_ids.json`.
- Bake script: `scripts/bake-longmemeval.ts <upstream_longmemeval_s.json>`.
- Adapter (med): `src/eval/adapters/longmemeval-med.ts`.
- Adapter (multiturn): `src/eval/adapters/longmemeval-multiturn.ts`.
- Judge: `src/eval/adapters/longmemeval-med.judge.ts`.
- Upstream snapshot: `references/lme/data/` (read-only).
- Original paper / repo: `github.com/xiaowu0162/LongMemEval`.

### Как скорится

LLM-judge с **5 question-type-specific prompt templates**, копированных
verbatim из `references/mle-harness/code/judge.py:13-66` (которые
скопированы из upstream `evaluate_qa.py`):

- `TPL_BASE` — generic «contains correct answer».
- `TPL_TEMPORAL` — «contains correct answer + off-by-one tolerated».
- `TPL_KU` (knowledge-update) — «correct as long as updated answer present».
- `TPL_PREF` — rubric-style; нет требования покрыть все пункты, только
  personal info правильно использована.
- `TPL_ABSTAIN` (для `_abs` вариантов abstain-questions) — модель должна
  отказаться отвечать.

Output: `"yes" | "no"` → `parseYesNo` → score ∈ {0.0, 1.0}.

### Пара типичных семплов

**`lme_01493427.json`** (knowledge-update):

```json
{
  "question": "How many new postcards have I added to my collection since I started collecting again?",
  "answer": "25",
  "question_type": "knowledge-update",
  "haystack_sessions": [ /* 47 сессий, ~2.6K tok каждая */ ],
  "haystack_dates": [ "2023/08/11 (Fri) 15:58", ... ],
  "haystack_session_ids": [ "answer_a7b44747_1", ... ]
}
```

Driver видит весь haystack, должен дать `"25"`. Judge принимает любой
ответ упоминающий «25 новых» как correct (TPL_KU permissive по
сравнению с TPL_BASE).

### Tools

**0 tools.** Single-turn QA — driver видит haystack + question, отвечает
текстом. Никаких retrieval / tool calls в нашем pipeline (отличается
от части upstream-baselines, которые гоняют retrieval-augmented setup
поверх того же датасета).

### System prompt

⚠️ **Caveat: код выглядит как paper-fidelity, но не работает так.**

`LME_DRIVER_SYSTEM` определён в `src/eval/adapters/longmemeval-med.ts:26`
verbatim из upstream `run_main.py:42-46`:

> You are a helpful assistant. Use the conversation history below to
> answer the user's question. Be concise: respond with the direct answer
> in <=2 sentences. If the answer is not in the history, say so.

**НО** — grep по `src/` показывает, что `LME_DRIVER_SYSTEM` импортируется
только в собственном тесте. **Ни одна baseline (full_context / mastra_om /
anthropic_compact / AHC) его не подаёт в actor.** Все используют
`DEFAULT_AGENT_SYSTEM_PROMPT` из `src/core/prompts.ts` — agentic-prompt
~500 токенов с разделами Style / Tool usage / Refusal, с фразой
*«Don't invent numbers, dates, names. If you cannot ground a claim, say so.»*

Импакт:
- Within-bench fair-comparison invariant **сохранён** (все baselines
  делят один и тот же `DEFAULT_AGENT_SYSTEM_PROMPT`).
- Cross-paper accuracy comparison **невалидна** — наши числа не сравнимы
  с upstream Wu et al. 2024 численно (другой system prompt → другое
  распределение abstain'ов → другая accuracy).

Тот же баг на LoCoMo (`LOCOMO_DRIVER_SYSTEM` тоже dead code, тоже только
в своём тесте).

**TODO для F-report**: либо wire `LME_DRIVER_SYSTEM` в baselines для
paper-fidelity и пересёрить lme-med (~$10), либо переименовать в
`LME_DRIVER_SYSTEM_UNUSED` + зафиксировать disclaimer в F-report'е.

### Подвариант: `lme-multiturn` (Track H Phase 1)

> **Provenance.** `lme-multiturn` — AHC-specific extension upstream
> LongMemEval (Wu et al. 2024), не часть оригинального бенча. Upstream
> описывает **только** single-shot протокол (haystack flatten → одно
> user-message → question). Мы вводим session-per-turn replay (Mode A,
> `docs/design/H_ablations_and_TODOs.md §12.2`), чтобы активировать
> observer на real данных. Subset / answers / judge / system prompt — те же,
> отличается только форма входных сообщений в `prepare()`.

**Как работает механически.** В каждой задаче N haystack-сессий
(N ≈ 41–63, median 49 across 120 baked tasks). Adapter генерирует
ровно **N+1 user-сообщений** и проигрывает их **строго по одному, от
первой сессии до последней**:

| turn | содержание user-сообщения |
|---|---|
| 1 | `[s_001 \| date]\nuser: ...\nassistant: ...` (вся первая haystack-session дословно) |
| 2 | `[s_002 \| date]\n...` (вторая session) |
| ... | ... |
| N | `[s_N \| date]\n...` (последняя haystack-session) |
| N+1 | сам вопрос задачи (`task.question`, например `"How many new postcards have I added to my collection since I started collecting again?"`) |

**Никакого батчинга нет.** Это НЕ «первые N-K сессий одним блоком, потом
K по одной». **Каждая** haystack-session — отдельный turn с самого
старта, в порядке появления в `haystack_sessions[]`.

**Что делает actor на каждом turn.** Runner-loop
(`src/eval/baseline.ts:33-56`) итерирует user-сообщения и вызывает
`baseline.step()` per-turn. Actor генерирует assistant-response **на
каждое из N+1 сообщений** — это структура multi-turn replay'а, иначе
нельзя. На turns 1..N actor видит session-dump (не вопрос); по telemetry
он отвечает 32–261 токенов per-turn (что-то вроде «OK, noted» или
комментирует session). Эти ответы — побочный продукт, не оцениваются.

**Что оценивается.** Только финальный ответ — assistant-response на
(N+1)-й turn, то есть на сам вопрос. Judge получает `lastResponse.text`
(`baseline.ts:79`) — это последний по времени assistant-response в
прогоне, то есть ответ именно на question-turn. Промежуточные N
assistant-ответов в скоринг не попадают (нигде даже не сохраняются —
только их token-counts оседают в per-turn telemetry).

**Side-effect для baseline'а `full_context`.** Промежуточные ответы
actor'а кладутся в conversation history. На финальный question-turn
`full_context` видит буквально
`[s_1, asst_r_1, s_2, asst_r_2, …, s_N, asst_r_N, question]` — контекст
«зашумлён» собственными комментариями actor'а. Это структурное
последствие multi-turn replay'я (не bug), но объясняет почему
`full_context` на lme-multiturn даёт accuracy 0.50, а на lme-med — 0.65.
Упирается в форму прогона, не в качество recall.

**Зачем мы это вообще делаем.** На lme-med весь haystack приходит в
одном user-message → AHC tier rotation не активируется, observer fires
0/240 records в Phase D (H6.5 audit). При session-per-turn replay после
K_RECENT=6 turns старые сессии переходят Tier-3 → Tier-2 через observer
(Task-Aware Extraction). С ~2.6K tok/session Tier-3 ≈ 7.8K после
3 сессий — выше `OBSERVER_THRESHOLD=4000` override в sweep YAML.

**Acceptance signal** Phase 1: observer event density ≥80% per cell.
Verified — 100% density на `ahc_full × lme-multiturn`. **Caveat (H8):**
до 2026-05-22 enrichTurnsWithEvents в runner двойного-аггрегировал
observer events (PATH A через `ahc_core` + PATH B через instrumentation
callback) — реальная density вдвое ниже репортированной. Числа выше
не пересчитаны, но bug пофикшен в runner.ts.

**Trade-off** — accuracy на lme-multiturn падает: AHC 0.13 на n=15 vs
`full_context` / `mastra_om` 0.50 на n=10. На пересечении тех 10 тасков,
что все три baseline'а успели обработать до budget-halt'а, AHC = 0.20.
Compaction выкидывает информацию, нужную для ответа. Mastra OM держит
~25K tok рабочее окно перед сжатием — за счёт этого сохраняет точные
факты (числа, имена), которые AHC при `OBSERVER_THRESHOLD=4000` сжимал
на каждом turn'е. Default подняли до 30000 в H Phase 8 — сравнимо с
Mastra envelope. Известные ограничения старой калибровки + H Phase 9
observer fix narrative — `docs/runs/baselines_frozen.md` (text-bench caveats).

**Где код**: `src/eval/adapters/longmemeval-multiturn.ts` (~70 LOC),
sweep `eval/sweeps/main_e1_text_lme_mt.yaml` (override
`OBSERVER_THRESHOLD: 4000` — историч артефакт того run'а, новый default
30000).

System prompt + judge + tools=0 — те же, что у lme-med (см. caveat
выше про `DEFAULT_AGENT_SYSTEM_PROMPT`).

---

## 3. LoCoMo (locomo-med)

### Название и роль

LoCoMo (Maharana et al., 2024 — `snap-research/locomo`, CC BY-NC).
В нашей терминологии — `locomo-med`. Multi-session dialog memory
benchmark, дополняет LME по той же оси (passive recall), но на
dialog-формате не QA-формате.

### Что покрывает

Каждый item — QA-вопрос над синтетическим многосессионным dialog'ом
между двумя speaker'ами (Tim ↔ John, etc.). Контекст ~17k токенов.

4 категории (frozen subset n=25 @ seed=42, stratified):

| category | n | name | Что меряет |
|---|---|---|---|
| 1 | 7 | single-hop | факт из одной session |
| 2 | 6 | multi-hop | требует комбинировать факты из 2+ sessions |
| 3 | 6 | temporal | временные отношения, dates |
| 4 | 6 | open-domain | knowledge + dialog facts |

Category 5 (adversarial / counterfactual) исключена upstream subset_ids.

### Где смотреть

- Baked tasks: `benchmarks/locomo/tasks/lo_*.json` (25 + 3 smoke).
- Subset frozen: `benchmarks/locomo/subset_ids.json` (mirror upstream).
- Bake script: `scripts/bake-locomo.ts <upstream_locomo10.json>`.
- Adapter + inline judge: `src/eval/adapters/locomo-med.ts`.
- Upstream snapshot: `references/locomo/data/`.
- Original paper / repo: `github.com/snap-research/locomo` (HF dataset
  `Percena/locomo-mc10`).

### Как скорится

LLM-judge **single template** (verbatim из `run_locomo.py:53-60`) —
«reasonable equivalence» prompt: модель отвечает yes/no, является ли
response эквивалентом correct answer (с tolerance к парафразу).
`parseYesNo` → {0.0, 1.0}.

В отличие от LME — нет per-category templates, один универсальный
judge. Категория `category` хранится в task'е для post-hoc per-class
report'ов (`scripts/per-class-report.ts`), но судья её не видит.

### Пара типичных семплов

**`lo_001.json`** (category 1, single-hop):

```json
{
  "sample_id": "conv-43",
  "qa_idx": 48,
  "category": 1,
  "category_name": "single-hop",
  "question": "When did John get an ankle injury in 2023?",
  "answer": "around November 16, 2023",
  "evidence": ["D18:2"],
  "conversation": {
    "speaker_a": "Tim",
    "speaker_b": "John",
    "session_1_date_time": "7:48 pm on 21 May, 2023",
    "session_1": [ /* turns... */ ],
    "session_2_date_time": "...",
    "session_2": [ /* ... */ ]
    // ... обычно 10-30 sessions
  }
}
```

Driver должен ответить ~«November 16, 2023» либо «around mid-November
2023» — судья tolerant.

### Tools

**0 tools.** Single-turn QA как у LME — driver видит conversation +
question, отвечает текстом.

### System prompt

**Provided** — `LOCOMO_DRIVER_SYSTEM` verbatim из upstream
`run_locomo.py:47-50`:

> You are a helpful assistant. Use the conversation history below to
> answer the user's question. Be concise: respond with the direct
> answer in <=2 sentences. If the answer is not in the history, say so.

Идентичен LME-driver-prompt'у (та же upstream формула — оба benches
ходили из одного авторского lineage). Baselines видят одинаково.

---

## 4. τ-bench retail (tau-bench-retail-med)

### Название и роль

τ-bench (Yao et al., 2024 — `sierra-research/tau-bench`, MIT). Из двух
доменов upstream (airline, retail) мы берём только **retail**. В нашей
терминологии — `tau-bench-retail-med`. Принципиально отличается от
LME/LoCoMo/AT тем, что это **live agentic loop**, а не replay — actor
вызывает tools, user-simulator отвечает, AHC compaction работает
**между actor steps**, не как pre-process.

### Что покрывает

Retail-помощник (assistant сценарий sierra-research style) — отменяет
заказы, обменивает товары, изменяет адрес. Toolset: ~15 retail tools
(`find_user_by_email`, `cancel_pending_order`, `exchange_delivered_order`,
…). User-simulator играет реального пользователя по `task.instruction`.

Mid-distance episodes — типично 8-20 actor steps, до 30 максимум.
Frozen subset — `benchmarks/tau-bench/subset_ids_n30.json` (30 episodes,
seed=42, superset 10-task original `subset_ids.json`).

### Где смотреть

- Baked tasks: `benchmarks/tau-bench/tasks/tau_retail_*.json` (30 + 2 smoke).
- Env initial state: `benchmarks/tau-bench/data/{users,orders,products}.json`.
- Retail policy / system prompt: `benchmarks/tau-bench/wiki.md`.
- Subset frozen: `subset_ids_n30.json` (E1+), `subset_ids.json` (legacy n=10).
- Bake script: `scripts/bake-tau-bench.ts <tau_bench_retail_dir> [--subset path]`.
- Expected end-state bake (Python): `scripts/bake_tau_expected_states.py`.
- Adapter + grader + runner: `src/eval/adapters/tau-bench-retail/`.
  - `index.ts` — adapter + grader + `makeTauBenchRunner` factory.
  - `agent-runner.ts` — episode loop (actor / user-sim alternation).
  - `env.ts` — `calculateReward` + env state mutation.
  - `tools.ts` — 15 retail tools.
  - `user-sim.ts` — user-simulator prompt + driver.
- Upstream pip package: `pip install git+https://github.com/sierra-research/tau-bench`.

### Как скорится

**Deterministic reward — без LLM judge.**

`calculateReward(envState, expected_end_state)` ∈ {0, 1} — точное
сравнение терминального env state с baked `expected_end_state`:

- Для каждого order в `expected.orders[id]`:
  - `status` должен совпасть, если задан.
  - `items` (set of `item_id`) должны совпасть set-equality.
- Для каждого user в `expected.users[id]`:
  - `address.{address1, city, zip}` должны совпасть.

`expected_end_state` baked'ится через Python wrapper, replaying upstream
ground-truth actions через env. Если `expected_end_state = {}` —
pass-by-default (мы такие episode не используем для accuracy, но не
дропаем для cost/latency metrics).

В `Score.secondary` уходят `n_steps` и `n_tool_calls` для analysis
overhead в audit'ах.

### Пара типичных семплов

**`tau_retail_3.json`** (task_idx=3):

```json
{
  "episode_id": "retail_3",
  "task_idx": 3,
  "instruction": "You are Yusuf Rossi in 19122. You want to know how many tshirt options are available in the online store right now. You want to modify all your pending small tshirt to purple, same size, same v-neck, and prefer polyester. You are a private person that does not want to reveal much about yourself.",
  "initial_state": { /* users + orders + products */ },
  "expected_end_state": { "orders": { "#W...": { "items": [...] } } }
}
```

Actor должен: authenticate (через zip), найти order, list tshirt
options, exchange items, get user confirmation. User-simulator
играет приватного пользователя — не выдаёт user_id напрямую, требует
authenticate через zip+name.

**`tau_smoke_001.json`** — простая отмена pending order'а.

### Tools

**10 retail tools** (live exec через AI SDK v6 `tool()` definitions в
`src/eval/adapters/tau-bench-retail/tools.ts`):

| # | Tool | Что делает |
|---|---|---|
| 1 | `find_user_id_by_email` | Authentication по email |
| 2 | `find_user_id_by_name_zip` | Authentication по имени + zip |
| 3 | `get_user_details` | Профиль пользователя (адрес, payment methods, orders) |
| 4 | `get_order_details` | Детали заказа (status, items, totals) |
| 5 | `get_product_details` | Каталог product + варианты item |
| 6 | `cancel_pending_order` | Отмена pending order'а с reason |
| 7 | `modify_pending_order_address` | Изменение адреса доставки |
| 8 | `modify_user_address` | Изменение default user address |
| 9 | `return_delivered_order_items` | Возврат delivered items |
| 10 | `think` | Scratch reasoning для actor'а (no side effect) |

Subset upstream tau-bench retail (часть toolset'а отсечена при D5 bake
— например `exchange_delivered_order_items` отсутствует, на retail subset
n=30 не требуется). User-simulator имеет свой собственный, separate prompt
в `user-sim.ts` — не пересекается с actor's system prompt.

### System prompt

**Provided + wrapped** — retail `wiki.md` (upstream policy) подаётся
как `benchContext` в наш стандартный `buildSystemPrompt`
(`src/core/prompts.ts`):

- AGENTIC_HEADER (agent / multi-turn / compaction awareness).
- STYLE + TOOL_USAGE_POLICY + REFUSAL (наши secondary блоки).
- `benchContext` = весь `benchmarks/tau-bench/wiki.md` (retail policy ~200
  строк: authentication rules, cancel/modify/return/exchange procedures,
  domain basics) — это upstream provided часть.
- Tools — schemas автоматически от AI SDK, hints не дублируем.

В отличие от LME/LoCoMo (pure provided) — здесь два слоя: upstream
policy + наш agentic framing, потому что tau — единственный live
agentic bench, ему нужны явные правила compaction-awareness и
tool-usage policy.

---

## 5. GAIA-med (Track K)

### Название и роль

`gaia-med` — n=25 stratified subset из GAIA validation split (Mialon et al.
2023, `gaia-benchmark/GAIA` на HuggingFace, CC BY 4.0). Cross-domain
agentic bench: research questions с verifiable ground truth, требующие
multi-step tool use (web search → page visit → python compute → image
description integration). Закрывает gap в eval axes: tau-bench
узко-domain retail, GAIA cross-domain.

### Что покрывает

- 3 difficulty levels (upstream): 1=easy single-lookup, 2=medium chained,
  3=hard multi-tool. Distribution в subset: level 1=8, level 2=12, level 3=5
  (после attachment filter, original snapshot 30 → 25 effective).
- 5-tool surface: `web_search`, `visit_webpage`, `text_editor`,
  `python_exec`, `describe_image`.

### Где смотреть

- Baked tasks: `benchmarks/gaia/tasks/gaia_*.json` × 25.
- Vendored snapshot: `references/gaia/data/gaia_validation_30.json`
  (Holosophus 2026-05-26 snapshot).
- Bake script: `scripts/bake-gaia.ts` (filter `has_file:true` tasks per
  Medium scope).
- Schema: `src/eval/adapters/gaia-med.schema.ts`.
- Adapter + grader + system prompt:
  `src/eval/adapters/gaia-med.ts`.
- Tools: `src/eval/adapters/gaia-tools/{web-search,visit-webpage,
  text-editor,python-exec,describe-image}.ts`.
- Agent runner: `src/eval/adapters/gaia-med/agent-runner.ts`.
- Design: `docs/design/K_gaia.md`.
- Numbers: `docs/runs/baselines_frozen.md` (gaia-med section).

### Как скорится

**Pure-normalization exact-match** (port `get_gaia_metrics.py:88-127`):
- Numeric path: strip `$,%,`, `parseFloat`, equality.
- List path: split by `,;`, per-element normalize (numeric or text),
  set-equality strict-position.
- Text path: lowercase + whitespace/punctuation strip, equality.

Extract via "Final answer:" prefix (fallback to full text). Decision:
no LLM judge per `decisions.md 2026-05-22` (faithful Mialon et al.
convention; cheaper + no `judge_cache.json`).

### Tools

5 AI SDK v6 `tool({...})` definitions, mirroring tau-bench shape (no Zod —
`jsonSchema()` per `decisions.md 2026-05-13 D5`):

| # | Tool | Provider | Env fallback |
|---|---|---|---|
| 1 | `web_search` | SearXNG → Tavily → Brave → mock | `SEARXNG_URL` / `TAVILY_API_KEY` / `BRAVE_API_KEY` / `MOCK_WEB_SEARCH=true` |
| 2 | `visit_webpage` | cheerio HTML extract | — |
| 3 | `text_editor` | read-only fs (workspace-rooted, path-traversal guard) | — |
| 4 | `python_exec` | `child_process.spawn` + 30s timeout + restricted env | `python3` on PATH |
| 5 | `describe_image` | OpenRouter vision model (gpt-5.4-mini) | `OPENROUTER_API_KEY` |

### System prompt

**Provided** — `GAIA_DRIVER_SYSTEM` verbatim из Holosophus
`run_gaia.py:25-44`. Template wraps question с `===` delimiters. Не
обёрнут в `buildSystemPrompt` (отличается от tau-bench retail) — GAIA
prompt prescriptive enough на своё (`"Final answer:"` format requirement).

### Tools (live deps)

`OPENROUTER_API_KEY` (actor) + один из 4 web_search providers. Без
provider — `MOCK_WEB_SEARCH=true` validates pipeline только (accuracy = 0).

---

## Конвенции общие

- **Seed=42** — frozen везде, mirror'ится в `benchmarks/<bench>/subset_ids.json`.
  Cross-replication через seed=43 — H4 phase (см. H ablations doc).
- **Judge cache**: `benchmarks/<bench>/judge_cache.json` — keyed по
  `sha256(prefix + canonicalJson(request))`. Cache hits возвращают
  `cost_usd: 0`, не блокируют resume.
- **Smoke fixtures** — каждый bench shipps 2-3 hand-built smoke task'а
  (`<bench>_smoke_*` / `at_*_001..` если valid fixture), позволяют
  unit-style runs без полного bake.
- **Driver vs judge** — driver model задаётся через `AHC_ACTOR_MODEL`
  env (см. `project_actor_model_gpt_5_4_mini` memory). Judge всегда
  `anthropic/claude-sonnet-4.6` — независимая переменная.
- **Записи в `benchmarks/runs/**`** — git-ignored (см. `.gitignore:20`),
  не часть репо.

## См. также

- `docs/design/D_assistant-traj.md` — почему именно эти 4 benches
  (eval axes: medium-distance / passive-recall / agentic-state).
- `docs/design/B_eval-harness.md` — runner / grader / sweep mechanics.
- `docs/design/C_baselines.md` — какие baselines прогоняются (full_context,
  mastra_om, mastra_summarizer, ahc_*).
- `docs/runs/baselines_frozen.md` — числа per bench (4-bench + GAIA + tau)
  + Cross-bench ablations + audit caveats.
- `docs/runs/current.md` — активные workstreams (H observer extraction quality,
  J6 AT-v2 sweep, K-tail-3 AHC threshold sweep).
