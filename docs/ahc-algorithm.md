# AHC — Algorithm Overview

**Adaptive Hybrid Compaction** — middleware для сжатия истории сессии агентских
ассистентских систем на medium-distance траекториях (5–15 turns, ~20–80 atomic
steps). Этот документ — algorithm-only описание: что внутри, зачем, чем вдохновлено
и почему так а не иначе. План реализации и операционные детали (phase plan, public
types, pseudocode) — отдельно в [`design/A_ahc-algorithm.md`](design/A_ahc-algorithm.md).

---

## Abstract

AHC классифицирует текущую траекторию агента на дешёвых rules-based признаках
(`conversational | tool_heavy | mixed`) без LLM-вызова и маршрутизирует под класс
одну из двух политик компакции:

- **Task-aware Observer** — query-anchored extraction наблюдений из горячего хвоста
  в стабильную часть истории.
- **Type-aware Tool Offloader** — atomic-group detection (`tool_use`/`tool_result`
  пары) с размером выше threshold выгружаются в out-of-prompt scratchpad, в истории
  остаётся pointer-placeholder с компактным digest'ом.

Pointer-выгруженные `tool_result`'ы могут быть догружены обратно в контекст по
решению самого агента через инъецируемый tool `recall_tool_result(id)`. Compaction
живёт в 3-tier shape (Tier-1 const prefix / Tier-2 append-only observations / Tier-3
mutable recent), который сохраняет prompt-cache invariance by construction.

Ключевые свойства: zero-config defaults (калибровка ≤10 трасс opt-in), cache-friendly
by contract (проверяется unit-test'ом), AI SDK v6 совместимость как
`LanguageModelV2Middleware` без модификации пользовательского кода.

---

## 1. Что мы решаем

В среднем диапазоне траекторий (5–15 turns, ~10–80 steps) уже не работают наивные
стратегии накопления, но ещё не оправдан тяжёлый memory-stack:

- **Tool-result bloat** — задокументировано публично (Claude Code issue #23196:
  рост tool outputs 12KB→750KB→9.2MB в одной сессии до API rejection;
  openai/codex#14589: 79% session tokens содержится в tool outputs, 0% переживают
  native compaction). Single largest contributor к token usage на medium-traj.
- **Context distraction / poisoning** — модель повторяет старые tool calls /
  возвращает ранний галлюцинированный fact. Документированы Gemini 2.5 tech report
  (Pokémon-агент) и Anthropic «context engineering» writeup. Активны уже на
  ~32K токенов (Stanford «Lost in the Middle», Chroma «Context Rot»).
- **Cache thrashing** — любая мутация системного префикса или re-format истории
  инвалидирует prompt-cache. Naive recursive summarization превращает 90% cache hit
  rate в 0% (см. «Don't Break the Cache», arXiv:2601.06007).
- **Adaptive policy needed** — Anthropic Managed Agents и Cognition Sonnet-4.5
  lessons прямо признают, что оптимальный compaction-threshold модель- и
  task-зависим; «context resets», полезные для одной модели, вредны для другой.
  Один fixed-threshold workflow недостаточен.

Существующие решения этого слоя не покрывают:

- **Cross-session memory** (Mem0 / Letta / Zep / HippoRAG2 / A-MEM) заточена под
  50+ сессий, требует vector + graph DB; на 8 turns одной задачи extraction-based
  fact-storage не активируется содержательно.
- **Token-level compression** (LLMLingua / LLMLingua-2) ломает tool-call формат
  и не cache-friendly.
- **Server-side native compaction** (Anthropic `compact_20260112` /
  OpenAI `/responses/compact`) теряет tool outputs целиком и не cross-framework.
- **Trajectory folding с RL/SFT** (AgentFold / Context-Folding+FoldGRPO /
  ReSum-GRPO / Memex(RL)) требует обучения собственной политики — outside
  zero-config scope.

AHC — middleware-уровневая комбинация устоявшихся приёмов под этот зазор.

---

## 2. Метод

### 2.1 Data layout — 3-tier shape

Conversation history разрезается на три зоны:

- **Tier-1** — immutable: system prompt + tool definitions + first-N user messages.
  Это и есть cached prefix; bytes побайтно фиксированы.
- **Tier-2** — append-only: observation log + pointer-placeholders + trajectory
  class signal. Растёт только в конец, longest-prefix-match кэширования сохраняется.
- **Tier-3** — mutable: последние K turns verbatim + текущее incoming
  user-сообщение. Hot zone; полностью переписывается каждый turn, но маленькая.

Cache breakpoint ставится в конце Tier-1. Reflection (§2.7) — единственная
операция, которая может переписать Tier-2; событие observable и редкое.

### 2.2 Per-turn data flow

```
new_user_msg
    │
    ▼
[append to Tier-3]
    │
    ▼
classifier.update(history) ───────► trajectory_class
    │                                    │
    ▼                                    │
  dispatch ─────────────────────────────┘
    │
    ├──► conversational  : Observer only
    ├──► tool_heavy      : Offloader only
    └──► mixed           : Offloader → Observer (sequential, дифференцированные thresholds)
    │
    ▼
[Reflection if Tier-2 > REFLECTION_THRESHOLD]
    │
    ▼
maybe inject recall_tool_summary + recall_tool_full (if scratchpad non-empty)
    │
    ▼
assemble_context(Tier-1 + Tier-2 + Tier-3-clipped) ───► LLM call
```

Порядок на mixed — Offloader первым, чтобы Observer работал уже над компактифицированным Tier-3 (а не extract'ил факты из tool outputs, которые сейчас уйдут в pointer'ы). См. `compact.ts` (offloader блок `plan.runOffloader` → observer блок `plan.runObserver`).

### 2.3 Trajectory Classifier

Rules-based, **без LLM-вызова**. Фичи: `tool_call_density`,
`avg_tool_result_size`, `recent_tool_density`, `user_turn_ratio`,
`multimodal_flag`, `cumulative_tokens`, `turns_total`. Возвращает класс с
confidence-уровнем; класс пишется в Tier-2 metadata. Цена — единицы микросекунд.
Для устойчивости класс проходит через hysteresis (`HYSTERESIS_THRESHOLD=2`
последовательных turn'а до смены) — иначе на границе density classifier
осциллирует между `mixed` и `tool_heavy`.

Альтернатива «STITCH-style intent indexing с lightweight Haiku-call каждый turn»
(arXiv:2601.10702, даёт +35.6% на CAME-Bench в их измерениях) — рассмотрена и
не взята: extra-call per turn = latency cost не оправдан в нашей operational зоне;
intent-anchoring получаем неявно из current user message в Observer (§2.4).

### 2.4 Task-Aware Observer

Активен на conversational / mixed. Триггер — Tier-3 > `OBSERVER_THRESHOLD`
(дефолт 30K tokens, конфигурируется per-sweep — например 64K на GAIA);
экстрагирует query-anchored observations (что нужно current query, что уже
известно) и кладёт их append-only в Tier-2. Tier-3 после этого clip'ается до
**token budget** `TIER3_TOKEN_BUDGET` (~0.2 × `OBSERVER_THRESHOLD`), с
preservation atomic groups и inflight tool_use на хвосте. Изначальный «retain
last K turns» pattern заменён на token-based clipping в decisions.md
[2026-05-26]; K_RECENT параметр удалён.

Async-вариант (`ASYNC_OBSERVER` flag) — design-only в текущем MVP: модуль
`asyncBuffer.ts` существует и unit-tested, но не интегрирован в `compact.ts` —
observer всегда синхронный. Default `false`. Mastra Operative Memory называет
аналогичный pattern activation hooks; включение отложено за пределы MVP scope.

### 2.5 Type-Aware Tool Offloader

Активен на tool_heavy / mixed. Работает на уровне **atomic groups** — связок
`(tool_use, tool_result, ?immediate_assistant_text)`, которые не могут разрываться
(tool_use без tool_result ломает API).

Принцип решения:

- если `size(tool_result) > T_size` (на mixed — `T_size_mixed`, более агрессивно)
  ИЛИ `cumulative_tool_result_bytes > T_cum` — atomic group выгружается в
  scratchpad store, в Tier-3 (а после clip'а — в Tier-2) остаётся **pointer
  placeholder** формата:
  `[Offloaded #G## tool=<name> size=<bytes>B — summary: recall_tool_summary(G##); raw: recall_tool_full(G##)]`.
  Digest **не инлайнится** в placeholder — он живёт за `recall_tool_summary`
  (§2.6); placeholder лишь анонсирует доступ. Это решение из K-tail-3
  (decisions.md [2026-05-26]): inline-digest раздувал Tier-2 поинтерами по 200–500B
  каждый, теперь pointer ≈ 80B и digest подгружается только когда actor его
  реально просит.
- параллельные tool calls в одном tool message обрабатываются per-part:
  per-message replacement (старая реализация) затирал sibling parts. См.
  `offloader.ts:partReplacements`.
- последние `ALWAYS_KEEP_LAST_GROUPS=2` atomic groups никогда не offload'ятся
  — это hot context для текущего шага рассуждения.
- если есть хотя бы один offloaded item — в available tools агента инжектируются
  **два** recall tools (§2.6).

Digest для скрытого summary строится одной из 4 стратегий (порядок выбора в
`digest.ts:generateDigest`):

1. `CONTENT_AWARE_DIGEST` (основной, default on в production sweep'ах) —
   per-tool projectors для известных GAIA tools (`web_search` → top URLs +
   snippets head 300 chars; `visit_webpage` → title + head/tail excerpt;
   `python_exec` → stdout/stderr heads; `text_editor` → path + content head;
   `describe_image` → description с условным head-tail). Без LLM-вызова.
2. `SCHEMA_AWARE_DIGEST` (opt-in, fallback на unknown tools при content-aware) —
   schema-driven field projection.
3. `llm_summarize` (если передан `llmCaller` и SCHEMA off) — 80-token LLM call.
4. `rule_based` (terminal fallback) — head 300 + tail 300 chars.

Scratchpad — in-memory `Map<group_id, full_atomic_group>` (MVP); pointer roundtrip
(`offload(group) → pointer → recall_full(id) → original group`) проверяется
unit-test'ом (`scratchpad.test.ts`, `offloader.test.ts`).

Альтернатива «token-level compression через LLMLingua» рассмотрена и отвергнута:
ломает структурные delimiter'ы tool-calls, требует small-LM dependency, не
cache-friendly (полностью переписывает токены каждый turn).

### 2.6 Recall Tools — two-stage rehydration

Когда scratchpad non-empty, в Tier-1 инжектируются **два tools** (K-tail-3,
decisions.md [2026-05-26]):

- **`recall_tool_summary(recall_id, reason)`** — возвращает content-aware
  digest (§2.5) offloaded группы. Cheap. Actor зовёт первым: для большинства
  использований digest содержит достаточно (top URLs + key facts + numeric IDs),
  и raw body не нужен.
- **`recall_tool_full(recall_id, reason)`** — возвращает оригинальный atomic
  group полностью, инжектируется в Tier-3 как обычное tool_result сообщение.
  Expensive (вернёт обратно тысячи токенов). Actor зовёт fallback'ом если
  summary недостаточен.

Семантика: оба tool'а зовут scratchpad'у `get(recall_id)`. Решение о догрузке
— **делегировано агенту**: auto-rehydration вернула бы context bloat обратно;
делегирование агенту — то же что Memex idea (in-context summary + external KV
store с dereference, arXiv:2603.04257), но без RL-fine-tuning'а собственной
политики — нужный нам zero-config контур. Шаблонно соседствует с MemGPT
page-in/page-out, но без OS-level overhead Letta.

**Two-stage** вместо single recall — фикс K-tail-3 (2026-05-26): single-tier
digest либо был lossy (actor не получал нужный fact и заново звал оригинальный
tool, удваивая стоимость), либо нёс слишком много для cheap-default'а
(раздувал каждый pointer). Two-tier escalation: actor платит summary-cost
почти всегда + full-cost только когда без оригинала действительно не обойтись.

### 2.7 Reflection Layer

Opt-in под флагом `REFLECTION` (default on, но триггер редкий). Когда Tier-2
превышает порог (~40K tokens), Reflector переписывает Tier-2 целиком — это deep
recompression observation log'а.

Reflection — единственная операция, нарушающая cache invariance contract (§2.9).
Trade-off осознанный: без неё Tier-2 растёт неограниченно, с ней — теряем
prompt-cache на хвост до следующего cache-warming turn'а. Event observable +
редкое; в инструментации помечается как `cache-invalidating`.

Альтернатива «recursive summarization как hot path» (RecSum / Letta `recall_memory`
/ Claude Code `/compact` ~83.5%) рассмотрена и отвергнута: «telephone game»
degradation измерена публично — Codex measurement в issue #14589: 13.7% retention
после 1st compact → 6.9% после 2nd. У нас reflection — escape valve, не основной
механизм.

### 2.8 Calibration Protocol — design only

Заявленный протокол: тюнятся 4 параметра — `T_size` / `T_size_mixed` (per-group
offload thresholds), `T_cum` (cumulative budget), `OBSERVER_THRESHOLD`
(observer-trigger size) / `TIER3_TOKEN_BUDGET`. Calibration trace — короткий
формат: `{trajectory, expected_outcome}`; pipeline предполагался leave-one-out
на ≤10 трассах с sensitivity-analysis к размеру calibration set.

**Статус в MVP: design only, не имплементировано.** `CALIBRATION_AUTO` flag
существует как placeholder (default false), автоматического calibration loop'а
в репо нет. Tuning thresholds сделан **вручную** через iteration log в
`decisions.md` (`OBSERVER_THRESHOLD` 8000→30000→64000, `REFLECTION_THRESHOLD`
40000→100000, T_size_mixed появился в A2 как разъезд от T_size) — каждый
сдвиг параметра обоснован short-run sweep'ом на 3-task corpus с явным
trade-off note.

Anthropic Managed Agents blog даёт эмпирический хинт, что delta между правильным
и неправильным timing compaction — 10–20% accuracy. Reading: ROI на full
automated calibration pipeline в зоне MVP не превзошёл стоимость имплементации;
manual iteration log оказался достаточным наблюдаемым process'ом — отложено
из MVP scope.

### 2.9 Cache Invariance Contract

Жёсткий инвариант, проверяемый отдельным unit-test'ом
(`src/core/cacheInvariance.test.ts`):

```
∀ turn i: bytes(Tier-1 + Tier-2_stable)_{turn_i} == _{turn_{i-1}}
where Tier-2_stable = Tier-2 up to last reflection event
```

Нарушение — баг, не trade-off. Reflection — единственная операция, легитимно
нарушающая контракт, и она наблюдаема в инструментации.

Это и есть «cache-aware compaction» в виде контракта, не побочного эффекта.
Подход мотивирован публичной находкой «Don't Break the Cache» (arXiv:2601.06007):
cache-friendly стратегия даёт 41–80% cost reduction и 13–31% TTFT reduction в
проде; любая мутация префикса инвалидирует все downstream-токены кэша. Существующие
memory-фреймворки не дают cache-aware API.

---

## 3. Прообразы — что взяли откуда

| Компонент AHC | Прообраз | Что именно заимствовано |
|---|---|---|
| 3-tier shape (Tier-1 / Tier-2 append-only / Tier-3 mutable) | Mastra Operative Memory + cache-prefix guidelines («Don't Break the Cache», arXiv:2601.06007) | Append-only Tier-2 + immutable Tier-1 как обязательный data layout |
| Cache invariance contract | «Don't Break the Cache» + Anthropic prompt-caching docs | Bit-exact bytes по Tier-1 + Tier-2_stable между turn'ами как unit-tested инвариант |
| Type-Aware Tool Offloader | Microsoft Agent Framework `MessageGroup` + IBM Materials Science pointer-pattern + Cognition Devin sub-agent pattern | Atomic group detection + pointer-replacement при size threshold + scratchpad store + agent-aware digest |
| Recall Tools (two-stage: summary + full) | Memex (arXiv:2603.04257) + MemGPT page-in/page-out + own K-tail-3 iteration | Селективная регидрация offloaded items по решению агента + cost-tiered escalation (cheap digest → raw body) |
| Task-Aware Observer | Mastra `observationalMemory` + STITCH intent indexing (arXiv:2601.10702) | Query-anchored projection Tier-3 → Tier-2; current query как intent-anchor для retention decision |
| Trajectory Classifier | Anthropic Managed Agents writeup + Cognition Sonnet-4.5 lessons | Adaptive routing per-trajectory; classifier работает на cheap-features без LLM-call |
| Reflection layer | RecSum / ReSum / AgentFold lineage | Deep recompression как редкий escape valve, не hot path |
| Calibration ≤10 трасс | Anthropic «calibration on 10 traces» pattern + APC semantic caching | Тюн 2–3 параметра на calibration set с known outcomes; leave-one-out validation |
| Eval-axes framing бенчей | LongMemEval / LoCoMo / τ-bench / AssistantTraj как разные failure modes компакции | Multi-axis eval (passive recall / trajectory coherence / agentic state), не single-bench claim |

---

## 4. Что упростили

Эти упрощения относительно «полной» средней — осознанные, scope-driven
(MVP курса, ~4 недели):

- **Intent-anchoring без отдельного LLM-call.** STITCH-style IAC предлагает
  Haiku-level LLM-call каждый turn для обновления `current_goal / action_type /
  salient_entities`. AHC извлекает intent неявно из current user message внутри
  Task-Aware Observer — без extra-call, ценой более грубой intent-detection.
  Trade-off зафиксирован в `decisions.md`.
- **Digest path: `CONTENT_AWARE_DIGEST` как primary, schema-aware → fallback.**
  K-tail-3 (decisions.md [2026-05-26]) переключил основной digest path с
  schema-aware на per-tool projectors (`web_search`/`visit_webpage`/
  `python_exec`/`text_editor`/`describe_image`) — каждый знает return-shape
  своего инструмента и проецирует high-signal поля. Schema-aware
  (`SCHEMA_AWARE_DIGEST` flag, default off) — fallback для unknown tools или
  когда content-aware projector не подходит. LLM-summarize и rule-based
  truncation — два уровня ниже как terminal fallbacks. Pure-rule path
  свёрнут в `headTail()`-helper, схематично остался у §2.5 как нижний слой.
- **Async observer — design only.** Модуль есть, в hot path не подключён;
  observer всегда синхронный в MVP (см. §2.4). Trade-off: один extra-step
  latency на каждое observer-fire, но zero состояния между turns и upgradable
  путь к async без breaking change в Tier-2 контракте.
- **Calibration pipeline — design only.** Параметры тюнятся вручную через
  decisions.md iteration log; автоматического calibration loop'а в MVP нет
  (см. §2.8).
- **Adaptive trigger без attention-decay replay.** Calibration-Driven Compaction
  Trigger предполагал offline replay для нахождения «pointer-of-no-return»
  (точка где accuracy начинает падать). AHC ограничивается simple size-threshold
  + cumulative-threshold; tuning ограничен `T_size / T_size_mixed / T_cum /
  OBSERVER_THRESHOLD`.

---

## 5. Альтернативы и почему не взяли

| Подход | Почему не взяли |
|---|---|
| **Cross-session memory** (Mem0 / Letta / Zep / HippoRAG2 / A-MEM) | Заточены под 50+ session, требуют vector + graph DB. На 5–15 turns одной сессии extraction-based fact storage не активируется содержательно (Letta team об этом прямо пишет). Другая ниша, не overlap. |
| **Token-level prompt compression** (LLMLingua / LLMLingua-2 / SelectiveContext) | Ломает tool-call формат (структурные delimiter'ы сжимаются); не cache-friendly (полностью переписывает токены каждый turn); требует small-LM dependency. Architectural mismatch с middleware-уровнем. |
| **Trajectory folding с RL/SFT** (AgentFold / Context-Folding+FoldGRPO / ReSum-GRPO / Memex(RL) / CaT) | Требуют либо FT, либо custom RL — outside MVP scope. Идеи (folding, dereference) взяли в zero-config форме (Reflection + Recall), но обучаемую политику не строим. |
| **Server-side native compaction только** (Anthropic `compact_20260112` / OpenAI `/responses/compact`) | Используем как **baseline** (`anthropic_compact` C2), не как замену. Native: теряет tool outputs целиком, не cross-framework, не cache-aware. AHC задумана как cross-framework cache-aware ответ. |
| **Knowledge-graph memory** (HippoRAG2 / Zep / MemOS) | Infrastructure-grade (Neo4j / graph store); overkill для одной сессии 5–15 turns. Сложность интеграции в middleware-уровень AI SDK v6 не оправдана. |
| **Recursive summarization как hot path** (RecSum / Letta `recall_memory` / Claude Code `/compact` ~83.5%) | «Telephone game» degradation измерена публично (Codex issue #14589: 13.7% retention после 1st compact → 6.9% после 2nd). У нас reflection — escape valve, не hot path. |

---

## 6. Как мы это валидируем

Выбор «комбинации устоявшихся приёмов» — гипотеза, не доказанный факт. Каждый
компонент должен либо контрибьютить, либо честно показать что не контрибьютит.

Стратегия:

- **Cache invariance** — unit-test'ом, независимо от eval'а.
- **3-tier shape + offloader** vs наивное накопление — baseline `full_context` (C0).
- **AHC vs Mastra-style OM** (то же 3-tier shape, но без classifier и без
  recall_tool) — baseline `mastra_om` (C1).
- **AHC vs server-side native** — baseline `anthropic_compact` (C2).
- **Per-module attribution** — ablation grid (`eval/sweeps/ablation_e2.yaml`),
  feature-flags выключают по одному модулю.
- **Cross-axis** — 4 бенча покрывают 3 разные failure modes (passive recall /
  trajectory coherence / agentic state), single-bench claim ненадёжен.

Отрицательный результат на модуле — валидный output: говорит, что заимствованный
приём в нашей operational зоне не работает, и атрибутирует обратно к
конкретному источнику.

Полный eval-протокол + статистические критерии — `system_design.md §6`.

---

## 7. Где дальше

- **Pseudocode + public types + phase plan** — [`design/A_ahc-algorithm.md`](design/A_ahc-algorithm.md)
  (§2.3 модули, §2.4 public API, Phase map).
- **Cache invariance test** — `src/core/cacheInvariance.test.ts`.
- **Имплементация** — `src/core/` (ядро), `src/adapters/ai-sdk-v6.ts` (middleware).
- **Финальный paper** — [`../report/main.md`](../report/main.md) §3 Model Description.
