# AHC Algorithm — детальная спецификация

Документ описывает алгоритмическое ядро Adaptive Hybrid Compaction: модули, их контракты,
pseudocode и инварианты. Используется как референс при реализации (фаза A) и при написании
секции Model Description в курсовом отчёте.

Системные цели, scope, eval-protocol и план реализации — см. `system_design.md`.

---

## Meta

- **Track:** A (A1 shape + groups → A2 offloader → A3 observer → A4 classifier → A5 buffer + reflection → A6 AI SDK v6 adapter)
- **Wall-clock:** 15 дней (3 + 3 + 3 + 2 + 2 + 2)
- **Зависит от:** внутри проекта — ничего (foundational трек, старт day 1); внешний prereq для A6 — `docs/investigations/ai-sdk-v6-surface.md`
- **Блокирует:** B2 (telemetry consume'ит `CompactionEvent`/`RecallEvent` из AHC), E1 (main sweep требует A6), G2 (UI mount на A6 middleware)
- **Связь:** `system_design §7.2 Track A` (phase plan source), `system_design §6` (eval-protocol — что AHC должен поддержать), `design/B_eval-harness.md §3` (telemetry events, которые эмитит AHC), `decisions.md` (running log A-related решений — pnpm, JSON.stringify proxy для §9.1, AtomicGroup InflightToolUse)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе.

### Track A (после A6)

**Доступно:**
- `src/core/index.ts` экспортирует public surface (§2.4): типы `Message / Tier1/2/3 /
  AtomicGroup / FeatureFlags`, функции `compact() / recall()`, фабрику
  `makeAhcMiddleware(flags)` совместимую с AI SDK v6 `LanguageModelV2Middleware`.
- AHC можно навесить на любой `streamText / generateText` через middleware option;
  Track G mount'ит ровно эту точку входа.

**Demo (e2e):** `pnpm tsx scripts/demo-ahc.ts` — синтетический 10-turn trajectory
через middleware; печатает per-turn `{class, observations, scratchpad_size,
tokens_before, tokens_after, cache_read_input_tokens}`. Скрипт создаётся в A6 как
обязательный exit artifact (не оптика — это "потрогать руками" для пользователя/защиты).

**Acceptance gate:** `./scripts/verify.sh` зелёный + `pnpm tsx scripts/demo-ahc.ts`
не падает + на последнем turn'е demo-trace есть non-empty `scratchpad` и хотя бы
один `recall_event`.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **A1** | `src/core/{types,featureFlags,thresholds,atomicGroup,tiers}.ts` + `index.ts` re-export; `tierize(messages)` даёт корректный 3-tier split | `./scripts/verify.sh test:cache-invariance` + `./scripts/verify.sh test:unit` |
| **A2** | `compact(messages, ctx)` оффлоадит heavy tool_results в scratchpad с `PointerPlaceholder`; `recall(id)` возвращает оригинальный `AtomicGroup` | `pnpm exec vitest run src/core/offloader.test.ts` (atomic-group roundtrip) + `./scripts/verify.sh test:cache-invariance` |
| **A3** | Observer extract'ит `Observation[]` из conversational turn'ов; post-extract clip срабатывает на `bufferActivation=0.8` | `pnpm exec vitest run src/core/observer.test.ts` |
| **A4** | `classify(features)` → `TrajectoryClass` с hysteresis на смене | `pnpm exec vitest run src/core/classifier.test.ts` |
| **A5** | `AsyncBuffer` + `Reflection` активируются по thresholds; reflection — единственная operation, наблюдаемо ломающая §9 prefix | `pnpm exec vitest run src/core/buffer.test.ts src/core/reflection.test.ts` |
| **A6** | `makeAhcMiddleware(flags)` + `scripts/demo-ahc.ts` | `pnpm tsx scripts/demo-ahc.ts` + `./scripts/verify.sh` |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track A`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы из §2.4, которые трогает или вводит фаза.
- **TDD seed** — failing test, с которого фаза стартует (Red в TDD-цикле).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты (§2.4) | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **A1** 3-tier shape + atomic groups + feature flag scaffolding | — | A2, A3, A4 | §2.1, §2.3, §5.1 | `Message`, `Tier1/2/3`, `AtomicGroup`, `FeatureFlags` | §9.1 cache-invariance prefix test | §2.2 data flow (skeleton) |
| **A2** Type-Aware Offloader + Scratchpad + Recall | A1 | A5, A6 | §5 (all), §6 (all) | `PointerPlaceholder`, `CompactionContext`, `Thresholds.{T_SIZE,T_CUM}` | atomic-group roundtrip (offload → pointer → recall == original) + §9.1 не ломается | §2.3 модули, §5.3 digest strategies |
| **A3** Task-Aware Observer + observation log | A1 | A5 | §4 (all) | `Observation`, `Thresholds.OBSERVER_THRESHOLD` | Tier-2 append-only (existing entries не мутируются) + post-extract clip §4.3 | §2.2 dispatch (conversational branch) |
| **A4** Trajectory Classifier | A1 | A5, A6 | §3 (all), §2.2 dispatch | `TrajectoryClass`, `ClassifierFeatures` | hysteresis: смена `conversational → tool_heavy` требует 2 последовательных turn'а | §2.3 модули (classifier row), §3.3 disabled-mode |
| **A5** Async Buffer + Reflection Layer | A2, A3, A4 | A6 | §7 (all), §8 (all) | `Thresholds.{BUFFER_TOKENS,BUFFER_ACTIVATION,REFLECTION_THRESHOLD}` | buffer consume-once + reflection — **единственная** operation, наблюдаемо ломающая §9 prefix | §8.3 cache invalidation handling |
| **A6** AI SDK v6 middleware adapter | A5 + `investigations/ai-sdk-v6-surface.md` | G2 (UI), E1 (main sweep) | §2.2 data flow, §2.4 `Message`/`ContentPart` shape | (adapter, новых типов не вводит) | middleware passthrough сохраняет §9.1 на полном turn cycle | `docs/investigations/ai-sdk-v6-surface.md` (prereq) |

**Parallelization:** `A2/A3/A4` параллельны после `A1`; `A5` ждёт всех трёх; `A6` — в конце трека.

**Orthogonal / deferred:**
- §10 Calibration Protocol — не нужно для A1–A6; включается в E (sweeps) при необходимости.
- §1 Терминология — baseline, читаем один раз и держим в голове.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: plan-mode
разбивает фазу на task'и, прогресс трекается через TaskCreate / `implementation/<phase>.md`
по `templates/implementation_template.md`. Pseudocode и контракты остаются в design
doc как source of truth, не дублируются в implementation.

---

## 1. Терминология

Унифицированные термины, которые используются во всём проекте и в paper'е. До этого
момента в разговорной речи "шаг" использовался неоднозначно; ниже — закреплённая семантика.

- **Trajectory** — вся session от первого user message до текущего момента. Контейнер для
  всего history. Может содержать сколько угодно turns.
- **Turn** — одна логически завершённая (user message → assistant final response) пара.
  Внутри turn ассистент может сделать множество internal действий, но снаружи пользователь
  видит один request и один response.
- **Step** — атомарное действие внутри turn: одна LLM call ИЛИ одна tool execution. Один
  turn медианно содержит 1–10 steps, в tool-heavy случаях — до десятков.
- **Atomic group** — связка сообщений `(tool_use, tool_result, ?immediate_assistant_text)`,
  которые **не могут** разрываться при компакции. Tool_use без tool_result ломает API.
- **Trajectory class** — категория всей траектории на текущий момент: `conversational`,
  `tool_heavy`, `mixed`. Определяется classifier'ом, обновляется каждый turn.
- **Medium trajectory** — операционная целевая зона: **5–15 turns**, что соответствует
  ~20–80 steps в среднем и ~50–250 steps в tool-heavy crunches. Это target proeкт.
- **Conversational trajectory** — траектория с низкой tool-call density (< 0.3 tool call
  per turn), доминируют text exchanges, characteristic для long-term memory задач
  (LongMemEval, LoCoMo).
- **Tool-heavy trajectory** — траектория с высокой tool-call density (> 1.5 tool call
  per turn), characteristic для action-based агентских задач (τ-bench, AppWorld).
- **Mixed trajectory** — траектория, где density меняется по ходу: например, начинается
  как research-heavy, переходит в conversational follow-up.

---

## 2. Архитектура runtime

### 2.1 3-tier shape (data layout)

Conversation history представлена как три логически разных зоны, sliced по pointer'ам:

```
[ Tier-1: const prefix          ]  ← immutable; cached prefix end
  - system prompt
  - tool definitions
  - first-N user messages (N=1 default)

[ Tier-2: append-only observations ]  ← append only; cache-friendly
  - observation log entries
  - offloaded tool_result pointer placeholders
  - trajectory class signal (current_class, confidence)

[ Tier-3: mutable recent K turns   ]  ← hot context; mutates every turn
  - последние K turns verbatim (K=6 default)
  - текущий incoming user message
  - in-flight tool_use/tool_result pairs
```

Cache breakpoint ставится в конце Tier-1; Tier-2 растёт только аппендами, что сохраняет
longest-prefix-match кэширования. Tier-3 — единственная зона, которая полностью
переписывается на каждом turn (что нормально, она и так маленькая).

### 2.2 Data flow per turn

```
input: history (Tier1 + Tier2 + Tier3 + new_user_msg)

1. Append new_user_msg to Tier-3
2. classifier.update(history) → trajectory_class
3. dispatch by class:
     conversational  → task_aware_observer.maybe_extract(Tier-3, query=new_user_msg)
     tool_heavy      → type_aware_offloader.maybe_offload(Tier-3, atomic_groups)
     mixed           → both, c дифференцированными thresholds
4. После compaction: возможно добавить recall_tool в available_tools
5. assemble_context() → [Tier-1, Tier-2, Tier-3-clipped]
6. return to LLM call

(параллельно, async): observer.buffer_pre_compact(Tier-3) — заранее готовит сжатие
для следующего turn'а, если есть idle window
```

### 2.3 Модули и их зоны ответственности

| Модуль | Читает | Пишет | Когда работает |
|---|---|---|---|
| Trajectory Classifier | Tier-2, Tier-3 features | trajectory_class в Tier-2 metadata | Каждый turn (cheap, no LLM) |
| Task-Aware Observer | Tier-3 + current query | observation entries в Tier-2 | Conversational/mixed, async |
| Type-Aware Tool Offloader | tool_result в Tier-3 | pointer entries в Tier-2, scratchpad | Tool_heavy/mixed, sync |
| Scratchpad Store | — | offloaded originals (out-of-prompt) | По запросу offloader/recall |
| Recall Tool | scratchpad | — (инжектит tool def) | Когда есть ≥1 offloaded result |
| Async Buffer | Tier-3 | заранее prepared observations | Background, между turns |
| Reflection Layer | Tier-2 entire log | переписанный Tier-2 | Редко (когда Tier-2 > 40K tokens) |

### 2.4 Public types (cross-module contracts)

Канонические типы, на которые опираются core-модули. Реализуются в `src/core/types.ts`
и re-export'ятся через `src/core/index.ts`. Это **контракт**: изменение полей —
breaking change, требует обновления зависимых модулей и записи в `decisions.md`.

```typescript
// Message — мульти-modal формат, совместимый с AI SDK v6 message shape.
// Сохраняем provider-neutral; convertion в Anthropic/OpenAI делается в адаптерах.
type Role = 'system' | 'user' | 'assistant' | 'tool'

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }       // base64 or URL ref
  | { type: 'file'; mimeType: string; data: string }
  | { type: 'tool_use'; tool_use_id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; output: unknown; isError?: boolean }

type Message = {
  role: Role
  content: ContentPart[]
  metadata?: {
    turn_index: number
    step_index: number
    is_offloaded_pointer?: boolean   // marks pointer-placeholder messages
  }
}

// Tiers — slice'ы одной conversation. Не отдельные массивы в runtime,
// а pointer-based views поверх единого журнала (см. §3.1 system_design).
type Tier1 = {
  systemPrompt: Message
  toolDefinitions: ToolDefinition[]
  firstUserMessages: Message[]    // N=1 default
}

type Tier2 = {
  observations: Observation[]      // append-only log entries
  pointers: PointerPlaceholder[]   // offloaded tool_result placeholders
  classSignal: { class: TrajectoryClass; confidence: number; updatedAt: number }
}

type Tier3 = {
  recent: Message[]                // последние K turns (K=6 default)
  inflight: AtomicGroup[]          // незавершённые tool_use/tool_result пары
}

// AtomicGroup — см. §5.1; здесь — формальный тип.
type AtomicGroup = {
  group_id: string                 // hash(tool_use_id + turn_index)
  tool_use: Message
  tool_result: Message
  reasoning_chunk?: Message
  turn_index: number
}

// Observation — output Task-Aware Observer'а, append'ится в Tier-2.
type Observation = {
  timestamp: number
  confidence: 'high' | 'med' | 'low'
  statement: string
  subDetails?: string[]
  sourceTurn: number
}

// PointerPlaceholder — заменяет offloaded tool_result в Tier-2 view.
type PointerPlaceholder = {
  recall_id: string                // совпадает с group_id
  tool_name: string
  original_size_bytes: number
  digest: string                   // см. §5.3 digest generation strategies
  turn_index: number
}

// FeatureFlags — см. §5.1 system_design. Single source of truth.
type FeatureFlags = {
  TASK_AWARE_EXTRACTION: boolean
  TYPE_AWARE_OFFLOAD: boolean
  TRAJECTORY_CLASSIFIER: boolean
  ASYNC_OBSERVER: boolean
  RECALL_TOOL: boolean
  SCHEMA_AWARE_DIGEST: boolean
  REFLECTION: boolean
  CALIBRATION_AUTO: boolean
}

type TrajectoryClass = 'conversational' | 'tool_heavy' | 'mixed'

// ClassifierFeatures — см. §3.1 ниже; продублирован здесь для полноты contract.
type ClassifierFeatures = {
  tool_call_density: number
  avg_tool_result_size: number
  recent_tool_density: number
  user_turn_ratio: number
  multimodal_flag: boolean
  cumulative_tokens: number
  turns_total: number
}

// CompactionContext — передаётся в should_offload (см. §5.2) и observer triggers.
type CompactionContext = {
  flags: FeatureFlags
  groups_after_this: number
  cumulative_kept_tool_result_bytes: number
  current_class: TrajectoryClass
  thresholds: Thresholds
}

type Thresholds = {
  OBSERVER_THRESHOLD: number        // default 8000
  T_SIZE: number                    // default 4096
  T_CUM: number                     // default 24000
  K_RECENT: number                  // default 6
  BUFFER_TOKENS: number             // default 0.2
  BUFFER_ACTIVATION: number         // default 0.8
  REFLECTION_THRESHOLD: number      // default 40000
}
```

`ToolDefinition` и `ToolResultPayload` форматы — определяются адаптером (AI SDK v6
shape для primary integration; см. `docs/design/B_eval-harness.md` для baseline-wrappers).
Core не делает предположений о их структуре.

---

## 3. Trajectory Classifier

Cheap, rules-based, без LLM calls. Цель — определить current trajectory class для
выбора политики компакции.

### 3.1 Features

Вычисляются на каждом turn'е инкрементально (O(1) с running counters):

```typescript
type ClassifierFeatures = {
  tool_call_density: number       // tool_uses_total / turns_total
  avg_tool_result_size: number    // mean bytes of tool_result blocks
  recent_tool_density: number     // tool_uses in last 3 turns / 3
  user_turn_ratio: number         // user_msgs / total_msgs
  multimodal_flag: boolean        // any image/file attachment в history
  cumulative_tokens: number       // input tokens accumulated
  turns_total: number
}
```

### 3.2 Classification rules

Default rules (выводятся из ~10 калибровочных трасс, см. §10):

```typescript
function classify(f: ClassifierFeatures): TrajectoryClass {
  if (f.turns_total < 2) return 'mixed'  // cold start, не хватает signal
  
  const conv_score = (1 - f.tool_call_density) * f.user_turn_ratio
  const tool_score = f.tool_call_density * 0.5 + f.recent_tool_density * 0.5
  
  if (conv_score > 0.6 && tool_score < 0.3) return 'conversational'
  if (tool_score > 0.5) return 'tool_heavy'
  return 'mixed'
}
```

Веса и thresholds фиксированы в config; калибровка может их корректировать. Класс
обновляется каждый turn, но переключение политики **не моментальное** — есть hysteresis:
для смены conversational → tool_heavy нужно 2 последовательных turn'а с tool_score > 0.5.

### 3.3 Когда classifier выключен

При `TRAJECTORY_CLASSIFIER=false` агенту в конфиге передаётся фиксированный класс. Это
удобно для ablation runs и для случаев когда вызывающий код заранее знает класс задачи.

---

## 4. Task-Aware Observer

Query-anchored extraction в Tier-2 log. Конструктивно похож на Mastra Observer, но:
(а) conditioned на current user query, (б) async buffer-based, (в) фокус на medium-traj.

### 4.1 Триггер

Активируется когда Tier-3 (mutable tail) превышает `observer_threshold_tokens`
(default 8K). На conversational class — порог стандартный; на mixed — выше (12K),
чтобы оставить место для type-aware operations.

### 4.2 Что extractit

Промпт для observer LLM (cheap model — Gemini-3.1-Flash или Haiku-4.5):

```
You are a conversation observer. Given:
  - Recent messages: <Tier-3 fragment>
  - Current user query: <query>
  - Previous observations: <Tier-2 tail, last 4K tokens>

Extract observations that:
  1. Are relevant to current query OR could be relevant to similar follow-up queries
  2. Are factual statements (preferences, decisions, knowledge updates), not chit-chat
  3. Reference specific entities (user, files, prior turns)
  4. Mark confidence: high|med|low

Output format:
- timestamp (high|med|low) factual statement
  - sub-detail (if any)
```

Inspired by Mastra observation format (dated, prioritized event log). Output append'ится
в Tier-2 без переписывания existing entries.

### 4.3 Post-extraction cleanup

После успешной экстракции Tier-3 clip'ается с `bufferActivation=0.8`: оставляются 20%
свежего хвоста (последние ~1.5K tokens). Это **не** включает в-flight atomic groups —
если в Tier-3 есть незавершённый tool_use, он не trim'ается.

### 4.4 Конкретный pseudocode

```typescript
async function maybe_extract(tier3: Message[], query: string, prev_obs: Observation[]) {
  const tokens = count_tokens(tier3)
  if (tokens < OBSERVER_THRESHOLD) return  // wait
  
  const extracted = await observerLLM.run({
    messages: tier3,
    query,
    prev_observations: prev_obs.slice(-PREV_OBS_WINDOW),
    format: OBSERVATION_FORMAT,
  })
  
  tier2.append(extracted)
  tier3.clip_keeping_tail(0.2 * OBSERVER_THRESHOLD)  // keep ~20% recent
}
```

---

## 5. Type-Aware Tool Offloader

Селективная разгрузка tool_result в out-of-prompt scratchpad с pointer-substitution.
Главный механизм для tool_heavy и mixed классов.

### 5.1 Atomic group detection

Tool_use и tool_result связаны через `tool_use_id`. Atomic group:
```
{
  group_id: hash(tool_use_id + turn_index),
  tool_use: <message>,
  tool_result: <message>,
  reasoning_chunk: <optional assistant_text immediately before/after>,
}
```

Группа всегда обрабатывается атомарно: или вся остаётся, или вся offload'ится с
заменой на pointer. Никогда не trim'аем tool_result без удаления соответствующего tool_use.

### 5.2 Offload decision

```typescript
function should_offload(group: AtomicGroup, ctx: CompactionContext): boolean {
  const size = bytes(group.tool_result)
  
  // Always keep last 2 atomic groups (могут понадобиться next-step reasoning)
  if (ctx.groups_after_this < 2) return false
  
  // Size-based threshold
  if (size > T_SIZE) return true
  
  // Cumulative threshold across non-offloaded results
  if (ctx.cumulative_kept_tool_result_bytes + size > T_CUM) return true
  
  return false
}
```

Defaults: `T_SIZE=4KB`, `T_CUM=24KB`. На mixed — `T_SIZE=2KB` (агрессивнее).

### 5.3 Digest generation

Replacement pointer должен быть достаточно информативным, чтобы агенту не нужно было
**обязательно** recall'ить. Структура pointer'а:

```
[Offloaded tool_result #G42 | tool=search_docs | size=8.2KB
 | digest: "Found 3 docs matching 'auth middleware'. Top: doc_237 (score 0.91, snippet:
   'Configure middleware.ts to check session cookie...'). Also: doc_198, doc_452."
 | recall_id=G42]
```

Digest generation strategies (tried in order):
1. **Schema-aware projection** (если `SCHEMA_AWARE_DIGEST=true` и tool registered with
   JSON schema): проекция output на calibrated-important fields, truncate arrays > 5
   items.
2. **LLM-summarize** (default): single LLM call (cheapest model), prompt:
   `"Summarize this tool output in 80 tokens, preserving any IDs/scores/keys that could
   be referenced later"`.
3. **Rule-based fallback**: head+tail truncation (300 tokens) с markers.

### 5.4 Scratchpad store

Простой key-value store, в MVP — in-memory `Map<group_id, FullToolResult>`. Контракт:

```typescript
interface Scratchpad {
  put(id: string, payload: ToolResultPayload): void
  get(id: string): ToolResultPayload | null
  size(): number
}
```

Опционально persistable в SQLite/Redis для долгоживущих sessions, но в MVP не нужно.

---

## 6. Recall Tool

Когда есть offloaded results, агенту инжектируется tool:

```typescript
const recall_tool_definition = {
  name: 'recall_tool_result',
  description: 'Retrieve a previously offloaded tool result by its recall_id. Use when ' +
    'you need exact data from an earlier tool call (the pointer/digest in context is ' +
    'insufficient for current reasoning).',
  parameters: {
    recall_id: { type: 'string', description: 'The G## id from a pointer placeholder' },
    reason: { type: 'string', description: 'Brief why you need full data (for logging)' },
  },
}
```

### 6.1 Семантика recall

При вызове `recall_tool_result(G42, "need exact doc snippets to compose response")`:
1. Lookup в scratchpad.
2. Возвращается полный original tool_result.
3. **Не** влечёт автоматическое возвращение в Tier-2/Tier-3 verbatim — только текущий
   tool_response содержит данные. Это сохраняет cache invariance.
4. Recall logged в metrics (для tracking `recall_usage_rate`).

### 6.2 Когда инжектируется

- При `RECALL_TOOL=true` и `scratchpad.size() > 0`.
- Tool definition стабильна, не меняется per turn → не ломает cache prefix.

---

## 7. Async Buffer (Pre-emptive Observer)

Идея взята из Mastra OM: пока агент думает над следующим turn, в фоне можно
заранее подготовить компакцию. Активация при необходимости — мгновенная.

### 7.1 Buffer lifecycle

```typescript
class AsyncBuffer {
  private prepared: PreparedCompaction | null = null
  
  // Triggered when Tier-3 reaches bufferTokens=0.2 * OBSERVER_THRESHOLD
  async pre_compact(tier3_snapshot: Message[], query: string) {
    if (this.prepared) return  // already buffered
    this.prepared = await this.run_observer(tier3_snapshot, query)
  }
  
  // Called on real activation
  consume(): PreparedCompaction | null {
    const p = this.prepared
    this.prepared = null
    return p
  }
  
  invalidate() { this.prepared = null }  // если history mutated incompatibly
}
```

### 7.2 Activation hooks (Mastra-inspired)

- `activateAfterIdle`: если user idle > 5min, force pre-compact (синхронизированно
  с Anthropic prompt cache TTL).
- `activateOnProviderChange`: при смене модели (provider switch mid-traj) принудительно
  компактим, чтобы новая модель не ингестила огромный hot context.
- `blockAfter`: если буферизация не успела и Tier-3 превысил 1.2 × threshold, force sync.

---

## 8. Reflection Layer

Редкое событие — deep recompression Tier-2 observation log, когда он сам становится
жирным. Cache-killer, но триггерится редко.

### 8.1 Триггер

`reflection_threshold_tokens` (default 40K) в Tier-2. На medium-trajectory (5–15 turns)
это обычно не достигается, но в long-running sessions — да.

### 8.2 Что делает Reflector

Берёт весь Tier-2, отправляет в reflector LLM (более агрессивно сжимающую модель —
например GPT-5.4-mini):
- Объединяет связанные observations
- Удаляет outdated (отменённые/перезаписанные)
- Pertinently агрегирует
- Output — новый Tier-2 log, целевой size ≤ 50% от input

### 8.3 Cache invalidation handling

После reflection весь Tier-2 переписан → кэш на Tier-1 + (старый Tier-2) умирает.
Mitigation: новый Tier-1 + (новый Tier-2) кэшируется на следующем call'е, и дальше
снова валиден до следующей reflection. Реализуем `REFLECTION=true` как default,
поскольку Aleksei зафиксировал что нам это нужно.

---

## 9. Cache Invariance Contract

Жёсткий инвариант, проверяемый в unit-тестах:

```
∀ turn i: prefix(compact(history_i)) bytewise equals prefix(compact(history_{i-1}))
where prefix = Tier-1 + (Tier-2 up to last reflection event)
```

То есть всё что до последнего reflection — никогда не меняется. Reflection — единственная
operation, которая нарушает инвариант, и она наблюдаемая (logged + measurable).

### 9.1 Test для контракта

```typescript
test('cache invariance across turns', async () => {
  const ahc = new AHC(defaultConfig)
  const turn1 = await ahc.compact(history_after_turn_1)
  const turn2 = await ahc.compact(history_after_turn_2)
  const prefixLen = ahc.getCachedPrefixLength()
  expect(turn2.slice(0, prefixLen)).toBytewiseEqual(turn1.slice(0, prefixLen))
})
```

---

## 10. Calibration Protocol

Опциональный шаг (default OFF). При `CALIBRATION_AUTO=true` AHC принимает ≤ 10
калибровочных трасс с известными outcomes и тюнит thresholds.

### 10.1 Calibration trace format

```json
{
  "trajectory_id": "calib_001",
  "expected_class": "tool_heavy",
  "messages": [...],
  "final_outcome": { "success": true, "answer": "..." }
}
```

### 10.2 Что тюнится

1. **Classifier weights** — если expected_class предсказан неправильно ≥ 30% времени,
   recalibrate thresholds.
2. **T_SIZE, T_CUM** — sweep по grid (4 точки), выбирается Pareto-optimal по
   (final_outcome.success × cumulative_tokens).
3. **OBSERVER_THRESHOLD** — аналогично, sweep.
4. **Important schema fields** (для schema-aware digest) — какие fields из tool outputs
   реально нужны downstream (на основе recall patterns в успешных трассах).

### 10.3 Sensitivity и leave-one-out

Калибровочные результаты должны быть **robust**: с 9-из-10 трасс получаем те же
thresholds ± малая дельта. Если LOO даёт разные thresholds — overfit, falling back на
defaults.

### 10.4 Defaults без калибровки

Reasonable defaults из литературы (Mastra OM defaults, codex#14589 measurements):
- `OBSERVER_THRESHOLD = 8000`
- `T_SIZE = 4096`
- `T_CUM = 24000`
- `K_RECENT = 6`
- `BUFFER_TOKENS = 0.2`
- `BUFFER_ACTIVATION = 0.8`
- `REFLECTION_THRESHOLD = 40000`

Эти числа — стартовая точка; пилотный run (~10 трасс из target domain) корректирует
с минимальным эффортом.
