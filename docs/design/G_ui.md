# Track G Design — Demo UI

> Track-level design для локального demo-приложения, которое оборачивает AI SDK v6 + AHC
> middleware и даёт interactive chat для defense / самопроверки. Phase plan —
> `system_design §7.2 Track G`.

---

## Meta

- **Track:** G (G1 skeleton → G2 AHC integration → G3 telemetry sidebar)
- **Wall-clock:** 3 дня
- **Зависит от:**
  - **Track A целиком (A1–A6)** — A6 это adapter-обёртка над A1–A5; mount'ить пустую
    обёртку бессмысленно, демо требует работающий end-to-end (classifier + offloader +
    observer + recall). Точка интеграции — A6, но семантически нужен весь алгоритм.
  - **B2** — `compaction_event` / `recall_event` envelope + `ProviderUsageMapper`
    (per-turn token usage из OpenRouter) owned'ятся B2; G3 sidebar consume'ит тот же
    телеметрический поток (см. `B_eval-harness.md §9.6`).
  - `investigations/ai-sdk-v6-surface.md` — UI helpers (`useChat`) часть проверяемой
    surface area; для G1.
- **Блокирует:** ничего (G — demo artifact, не входит в research pipeline)
- **Связь:** `system_design §11` (как deliverable), `design/B_eval-harness.md §9` (observability)

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе. G — UI-трек, verify
> часто manual ("open localhost, do X, observe Y"); это ожидаемо (§4 exit criteria
> сформулированы так), Playwright/Cypress automated tests out of scope MVP.

### Track G (после G3)

**Доступно:**
- `src/ui/` — Next.js App Router project (collocated, single `package.json`),
  runnable локально через `pnpm run dev:ui` (см. §1 In-scope).
- Chat UI с text + image-by-URL input, multi-turn, history в browser localStorage.
- **Working assistant**: hardcoded system prompt (research-assistant) + 1 real
  tool `fetch_url(url) → string` + AI SDK v6 agent loop (`maxSteps:8`). Это даёт
  AHC что offload'ить — без `fetch_url` Tier3 пустой и демо бессмысленно.
- Sidebar показывает live AHC state per response: `class`, `confidence`,
  `observations` count, `scratchpad` size, `recall_events`, `compaction_events`,
  active feature flags + **tokens** (per-turn input/output/cache_read/offloaded +
  cumulative total/cost) (§3 UI shape). `offloaded` = AHC-side payload delta,
  главная мякотка демо.
- Backend `/api/chat` route с AHC middleware mount'нутым над OpenRouter provider
  (Gemini-3.1-Flash default); scratchpad per-session in-memory с 1ч TTL (§4.G2).

**Demo (e2e):** UI **сам** и есть demo — `pnpm run dev:ui` открывает localhost,
пользователь ведёт multi-turn chat (image URL опционально), видит assistant response
+ AHC sidebar обновляется per response. Это deliverable для защиты; отдельного
demo-скрипта нет.

**Acceptance gate:** все три §4 exit criteria пройдены (G1 multi-turn chat работает
+ image URL передаётся + system prompt применён; G2 AHC active, `fetch_url` работает,
compaction events, recall tool срабатывает на повторный URL; G3 sidebar live updates
per response включая token block) + ручной smoke на `localhost`: 10-turn trajectory
с 2–3 `fetch_url` вызовами на разных URL'ах, sidebar показывает non-zero scratchpad,
хотя бы один recall event, `tokens.offloaded > 0` на tool-heavy turn'ах, cumulative
`cost` накапливается + UI не падает при provider 5xx mid-stream (§5 failure mode).

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **G1** | `src/ui/` Next.js skeleton с `/api/chat` (passthrough на OpenRouter, no AHC); chat panel + text + image URL input; multi-turn через `useChat` (AI SDK v6); hardcoded system prompt + `maxSteps:8` agent loop (без tools пока) | `pnpm run dev:ui` → localhost: отправить 3-turn chat с image URL во втором turn, убедиться что image рендерится, provider response приходит, system prompt очевидно применён по тону ответа (§4.G1 Exit) |
| **G2** | AHC middleware mount'нут в `/api/chat`; **tool `fetch_url(url)` зарегистрирован** (server-side fetch + html-to-text, ~30 строк); feature flags из query params; per-session scratchpad `Map<sessionId, Scratchpad>` с TTL; recall tool инжектится когда scratchpad non-empty | `pnpm run dev:ui` → localhost с `?TYPE_AWARE_OFFLOAD=1`: 6-turn trajectory с 2 `fetch_url` вызовами на разные URL, в browser devtools network response видеть `compaction_event` и хотя бы один `recall_event` (на повторное обращение к ранее fetched URL) (§4.G2 Exit) |
| **G3** | Backend injects `ahc_stats` envelope (с `tokens` блоком) в response; sidebar рендерит class/confidence/observations/scratchpad/recall list + feature flag indicators + **tokens per turn (input/output/cache_read/offloaded) + cumulative total/cost**; updates per response | `pnpm run dev:ui` → localhost: 5-turn chat с `fetch_url`, после каждого assistant response sidebar обновляется (class меняется при tool-heavy turn'е, scratchpad size растёт, `tokens.offloaded` > 0 на turn'е после fetch, `cumulative.cost` накапливается) (§4.G3 Exit). При отсутствии B2 sidebar показывает client-side state only (§5 failure mode) |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track G`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — типы из §2.4 `A_ahc-algorithm.md`, которые трогает или потребляет фаза (Track G сам новых типов не вводит — он consumer).
- **TDD seed** — exit criterion из §4, с которого фаза стартует (Red в TDD-цикле).
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **G1** Skeleton + AI SDK v6 chat | `investigations/ai-sdk-v6-surface.md` | G2 | §4.G1, §1 In (assistant scaffold), §2 architecture, §3 UI shape | `Message`, `ContentPart` (text + image consumption); AI SDK v6 agent loop config (`maxSteps`) | end-to-end chat через UI, multi-turn, image URL передаётся, system prompt применён (§4.G1 Exit) | §1 Scope (in/out boundary), §7 cost caps |
| **G2** AHC integration | G1, A6 (transitively вся Track A) | G3 | §4.G2, §1 In (`fetch_url` tool), §2 architecture (middleware mount), §6 persistence policy | `FeatureFlags`, `Scratchpad` (per-session lifecycle), `ToolDefinition` (для `fetch_url` + Recall Tool); A_ahc-algorithm §5 offload triggers | AHC active, compaction events происходят, `fetch_url` работает, recall tool инжектится и срабатывает на повторный URL (§4.G2 Exit) | §5 failure modes (scratchpad TTL, rate-limit, fetch CORS), §7 cost / abuse |
| **G3** Telemetry sidebar | G2, B2 (telemetry envelope + `ProviderUsageMapper` — см. `B_eval-harness.md §9.6`) | — | §4.G3, §3 UI shape (sidebar panel включая tokens block) | `TrajectoryClass`, `Observation`, `PointerPlaceholder` (read-only, для display); `ahc_stats` envelope shape с `tokens.offloaded` (AHC-side payload delta) | live AHC stats обновляются per response, видно class/confidence/observations/scratchpad/recall + tokens (input/output/cache_read/offloaded) + cumulative cost (§4.G3 Exit) | §5 failure modes (provider 5xx mid-stream), `B_eval-harness.md §9` observability |

**Parallelization:** внутри трека — strict sequential (`G1 → G2 → G3`: skeleton → integration → observability); параллелить нечего. Кросс-трек: G1 ждёт `ai-sdk-v6-surface` investigation, G2 ждёт A6, G3 ждёт B2.

**Orthogonal / deferred:**
- §8 Open questions — design-level uncertainty, разрешаются по ходу; не блокируют фазы.
- §6 Persistence policy (post-MVP SQLite branch) — out of scope для G1–G3.
- §7 Cost / abuse — baseline caps реализуются в G2, тюнинг — orthogonal.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Scope

- **In**:
  - Single-page Next.js (App Router) chat UI, runnable locally (`pnpm run dev:ui`)
  - Text input + image URL input (multimodal: pure-text + image-by-URL)
  - Multi-turn conversation; trajectory сохраняется в browser localStorage
  - **Assistant scaffold** (необходим, чтобы AHC демо было meaningful):
    - **System prompt** — статический, hardcoded в `/api/chat` (research-assistant
      role: «use `fetch_url` для URL'ов, ground answers в полученном контенте»). Не
      настраивается из UI; ~3–5 предложений.
    - **Tool** — один: `fetch_url(url: string) → string` (server-side fetch +
      html-to-text, ~30 строк). Один tool достаточно, чтобы tool_result был большим
      (сотни токенов) → AHC offload и Recall видны. `web_search` не добавляем —
      дубликат value, лишняя интеграция.
    - **Agent loop** — `maxSteps: 8` через AI SDK v6 (configurable query param
      `?MAX_STEPS=`); stop conditions — defaults.
  - Sidebar показывает live AHC state: detected class, observation count, scratchpad size,
    recall events; **+ tokens per turn (input/output/cache_read/offloaded) + cumulative
    total/cost** — см. §3
  - Backend API route → AHC adapter → OpenRouter (Gemini-3.1-Flash default)
- **Out**:
  - User auth / multi-user
  - Image upload (только URL — урезает scope на storage/multipart)
  - Server-side persistence; browser-only state (см. `system_design §11.3`)
  - Production-grade UX (mobile, accessibility) — basic styling достаточно
  - Streaming markdown edge cases — simple text/code blocks ok; tables/KaTeX out
  - Дополнительные tools (`web_search`, file system, code interpreter) — один
    `fetch_url` достаточно для демо AHC offload; остальное scope creep. Roadmap
    для расширения palette зафиксирован в §"Tool palette extensions (post-G3)".
  - Конфигурируемый system prompt из UI — hardcoded достаточно
  - Multi-agent / handoff scenarios — single agent loop

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser (Next.js client component)                                │
│   - useChat hook (AI SDK v6 UI helpers)                           │
│   - chat panel + sidebar (telemetry)                              │
│   - state: messages + last AHC stats — все в React + localStorage │
└──────────────────────────────────────────────────────────────────┘
                          │  POST /api/chat
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ Next.js Route Handler (Node runtime)                              │
│   - construct AI SDK Agent с AHC middleware (см. §7.2 A6)         │
│   - stream response back                                          │
│   - emit telemetry envelope (JSON / SSE side-channel)             │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
              AHC middleware → provider (OpenRouter)
                          │
                          ▼
              (opt-in) Telemetry → Langfuse (см. design/B_eval-harness.md §9)
```

Single Next.js process, no extra services. Langfuse поднимается отдельно через
`docker-compose` — opt-in, не required для UI самого по себе.

**Tech choice (Next.js + AI SDK v6, не gradio/Streamlit).** AHC middleware — это
`LanguageModelV2Middleware` interface из AI SDK v6, TypeScript-only. Python-сайд
UI (gradio/Streamlit) потребовал бы либо RPC-моста к TS-процессу с AHC, либо
дублирующего provider-wiring на Python — обе опции добавляют слой без выигрыша.
Next.js + AI SDK v6 — single-process integration, AHC mount'ится напрямую в
`/api/chat` route handler. UI косметика out of scope (§1 Out) — basic Tailwind
достаточно, "функционально, не красиво" — explicit acceptance.

---

## 3. UI shape

```
┌─────────────────────────────────────┬───────────────────────┐
│  Chat                                │  AHC Telemetry        │
│  ┌──────────────────────────────┐    │  class: tool_heavy    │
│  │ user: ...                    │    │  confidence: 0.78     │
│  │ assistant: ...               │    │  observations: 3      │
│  │ ...                          │    │  scratchpad: 2 items  │
│  └──────────────────────────────┘    │  recall events: 1     │
│                                       │                       │
│  [ text input              ] [Send]  │  ── tokens (this turn)│
│  [ image URL (optional)    ]         │  input:      3421     │
│                                       │  output:      412     │
│                                       │  cache_read: 2900     │
│                                       │  offloaded: ~1800     │
│                                       │                       │
│                                       │  ── cumulative        │
│                                       │  total:    18420      │
│                                       │  cost:     $0.012     │
│                                       │                       │
│                                       │  flags:               │
│                                       │  [x] TASK_AWARE       │
│                                       │  [x] TYPE_AWARE       │
│                                       │  [ ] REFLECTION       │
└─────────────────────────────────────┴───────────────────────┘
```

Sidebar обновляется по telemetry events возвращаемым с каждым assistant response.
Feature flag toggles — query params, перезагружают session.

**Token блок — главная "мякотка" демо.** `offloaded` — payload-size delta до/после
`compact()` (AHC-side, не provider usage); этого нет в Langfuse (там сырые
`cache_read_input_tokens` и т.п. из провайдера). `cache_read` берётся из
`ProviderUsageMapper` (B2). `cost` — суммарный за session по pricing snapshot
из `src/eval/llm.ts` (B2). На turn'е без compaction `offloaded` = 0 — это тоже
информативно (показывает, что AHC классифицирует turn как "не trigger'ить
offload" — query-light / chat_only).

---

## 4. Phase breakdown

### G1. Skeleton + AI SDK v6 chat (1 день)

- Next.js App Router project в `src/ui/` (collocated, single package.json).
- API route `/api/chat` без AHC — just OpenRouter passthrough.
- **Минимальный agent-каркас**: hardcoded system prompt (research-assistant role,
  ~3–5 предложений) + `maxSteps:8` (через AI SDK v6 agent loop, configurable
  `?MAX_STEPS=`). Tools пока нет — single LLM call per turn; этого хватает для
  multi-turn text chat и валидации UI helpers до A6.
- Image URL input — UI поле; конвертится в `{type:'image', mimeType, data:<url>}`
  ContentPart перед отправкой.
- Verify: AI SDK v6 UI helpers (`useChat` или equivalent) работают с OpenRouter provider —
  закрывается в `ai-sdk-v6-surface` investigation (см. A6 prerequisite в `system_design §7.2`).
- **Exit**: можно поговорить с моделью через UI; multi-turn; image URL передаётся;
  system prompt применён (видно по поведению модели).

### G2. AHC integration (1 день)

- Mount AHC middleware над provider в `/api/chat`.
- **Tool `fetch_url(url: string) → string`**: server-side fetch с timeout 5s +
  html-to-text (`turndown` / `cheerio.text()`, ~30 строк). Регистрируется в AI SDK
  `tools` массиве рядом с AHC Recall Tool. Один tool достаточно: tool_result от
  `fetch_url` крупный (сотни токенов) → AHC Type-Aware Offloader срабатывает →
  scratchpad заполняется → Recall Tool становится релевантен. Без real tool Tier3
  пустой и AHC offload не виден.
- Feature flags из query params (для quick toggling в demo: `?TYPE_AWARE_OFFLOAD=0`).
- Scratchpad lifecycle: per-session, in-memory `Map<sessionId, Scratchpad>` в API process.
  `sessionId` — uuid в browser localStorage, передаётся в request header.
- Eviction: scratchpad drop'ается после 1ч idle (in-memory TTL).
- **Exit**: AHC active, compaction events происходят, `fetch_url` работает, recall tool
  работает (вторая попытка fetch'нуть тот же URL → AHC рекомендует Recall вместо повторного
  fetch).

### G3. Telemetry sidebar (1 день)

- Backend injects AHC stats в response (JSON envelope `{message, ahc_stats}` или SSE event).
- **`ahc_stats` shape**: `{class, confidence, observations_count, scratchpad_size,
  recall_events, feature_flags, tokens: {input, output, cache_read, offloaded},
  cumulative: {total, cost_usd}}`. Контракт envelope — общий с B2 telemetry pipeline
  (`B_eval-harness.md §9.6`); `offloaded` — AHC-side payload delta (до/после `compact()`),
  не дублирует Langfuse.
- Frontend sidebar отображает live: class, confidence, observations count,
  scratchpad size, recall events list, current feature flags, **tokens (per-turn +
  cumulative + cost)** — см. §3 mock.
- **Exit**: во время разговора видно как AHC компактит **в токенах** — `offloaded`
  растёт на tool-heavy turns, `cache_read` показывает stable prefix hit, `cost` —
  накопительный. Основная demo-ценность: "AHC не просто работает — вот сколько
  токенов он сэкономил вот в этом chat".

---

## 5. Failure modes

| Mode | Mitigation |
|---|---|
| AI SDK v6 UI helpers unstable / breaking | Fallback на manual fetch + SSE; investigation prerequisite |
| OpenRouter rate-limit на demo | Per-session rate-limit info shown в UI; clear error message |
| Image URL не загружается (CORS / 404) | Validate URL before send; show inline error |
| `fetch_url` tool: 404 / timeout / non-HTML | Tool возвращает structured error `{ok:false, reason}` в tool_result; agent loop видит и реагирует; не падает |
| `fetch_url` tool: huge page (>50KB text) | Hard cap output на ~8000 chars + suffix `[truncated]`; AHC всё равно offload'ит через T_SIZE |
| Scratchpad растёт без cleanup | TTL eviction 1ч idle |
| Provider 5xx mid-stream | Show error inline, keep history; allow retry last user msg |
| `tokens.offloaded` не считается (B2 envelope incomplete) | Sidebar показывает `—` для поля; остальные блоки работают (degraded display, не блокирует G3) |

---

## 6. Persistence policy

См. `system_design §11.3`. Сжато для Track G:

- **Browser localStorage** хранит: `sessionId`, conversation history, last feature flags.
- **Server in-memory** хранит scratchpad'ы — gone on restart (acceptable: user reload'ит
  ту же conversation из localStorage, scratchpad rebuild'ится из history через AHC).
- **No DB** — sustainable до конца MVP.
- Post-MVP, если нужна durable session restore (cross-restart scratchpad) — `better-sqlite3`,
  не Postgres. Зафиксировано в `decisions.md` 2026-05-13.

---

## 7. Cost / abuse considerations

UI запускается локально с собственным OpenRouter key:

- Rate-limit per-session (default 20 messages / 5 минут).
- Hard message-length cap (8000 chars input).
- Image URL fetch с timeout 5s.
- **`fetch_url` tool**: timeout 5s, output cap 8000 chars, per-session cap 30 вызовов /
  5 минут (защита от agent-loop'а с дорогими tool calls; `maxSteps:8` это уже ограничивает,
  но cap — second line).

Защита от accidental loops, не от malicious abuse — не production.

---

## Open questions

1. Monorepo `apps/demo-ui/` или collocated `src/ui/`? Default — collocated (один
   package.json, проще dev). Revisit если UI вырастет.
2. Streaming UI — token-by-token streaming или per-message updates? Default —
   streaming text, AHC stats передаём после complete response.
3. Image URL fetch — proxy через backend (CORS-safe) или direct browser fetch?
   Default — direct (image rendering в browser); если CORS блокирует — backend proxy.
4. Feature flag UI — query params (refresh required) или live toggle? Default —
   query params (проще и безопаснее для session state).
5. `fetch_url` html-to-text: `turndown` (markdown), `cheerio.text()` (plain) или
   `@mozilla/readability` (article extraction)? Default — `cheerio.text()` как
   простейший; revisit если model плохо парсит результат.
6. `tokens.offloaded` precision — payload-string-length delta или re-tokenize
   через provider tokenizer? Default — string-length / 4 (rough estimate) для G3,
   точный counter через `ProviderUsageMapper` (B2) если будет cheap.

---

## Migration target (post-E0): adopt shared `createAhcRuntime`

Текущий `src/ui/app/api/chat/route.ts` (G2 deliverable) собирает AHC-over-AI-SDK
wiring inline:

```ts
// route.ts:58-78 — нынешний паттерн
const openrouter = createOpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
const baseModel = openrouter.chat(MODEL_ID);
const middleware = createAhcMiddleware({ flags, sessionId, scratchpadRegistry, emit, onCompactResult });
const model = wrapLanguageModel({ model: baseModel, middleware });
// ...streamText({ model, ... })
```

Параллельная eval-side wiring в `src/eval/runners/ahc_core.ts` точно такого же шейпа
дублировала эту обвязку. **Track E (E0 step) extract'нул shared factory
`createAhcRuntime` в `src/adapters/ahc-runtime.ts`** и мигрировал eval-side. UI-side
миграция — отдельный handoff, описан здесь. Сам `createAhcRuntime` + unit-тесты на
оба провайдера (openrouter / anthropic_direct) уже на месте; миграция route.ts —
**pure refactor без поведенческих изменений**.

### Target shape (after migration)

```ts
import { createAhcRuntime } from '../../../adapters/ahc-runtime';

// inside POST(req)
const { model } = createAhcRuntime({
  provider: 'openrouter',
  apiKey,
  model: MODEL_ID,
  flags,
  sessionId: () => sessionId,
  scratchpadRegistry: SESSION_REGISTRY,
  emit: (event) => events.push(event),
  onCompactResult: (_sid, result) => {
    lastObservationsCount = result.newTier2.observations.length;
    lastScratchpadSize = SESSION_REGISTRY.get(sessionId).size();
  },
});
// ...streamText({ model, system: SYSTEM_PROMPT, messages, ... }) — без изменений
```

### Checklist для агента, который будет делать миграцию

- [ ] Прочитать `src/adapters/ahc-runtime.ts` + `ahc-runtime.test.ts` — API уже стабилен.
- [ ] Заменить inline wiring в `src/ui/app/api/chat/route.ts:58-78` на `createAhcRuntime({...})`.
- [ ] Убедиться, что `SESSION_REGISTRY` совместим с `scratchpadRegistry` параметром
      (это `SessionScratchpadRegistry` из `src/adapters/sessionScratchpad.ts` — должно быть
      structural match).
- [ ] `MODEL_ID` (`google/gemini-3-flash-preview`) + `OPENROUTER_BASE_URL` остаются на UI-side
      как константы; `createAhcRuntime` берёт их через `model` + дефолтный baseURL для
      `provider:'openrouter'`.
- [ ] `pnpm vitest run src/adapters/ahc-runtime.test.ts` зелёный.
- [ ] Manual smoke: `pnpm run dev:ui`, открыть localhost, 2-turn chat с `fetch_url`,
      убедиться что `ahc_stats` envelope приходит как раньше (compaction_events,
      class_signal, observations count).
- [ ] `./scripts/verify.sh` зелёный.

### Что НЕ менять в этой миграции

- `createAhcMiddleware` (живёт в `src/adapters/ai-sdk-v6.ts`) — не дублируется и не
  расширяется; `createAhcRuntime` его использует внутри.
- `streamText({...})` call (line 88-105 route.ts) — поведенчески не меняется; только
  `model:` параметр приходит из `createAhcRuntime` вместо inline `wrapLanguageModel`.
- `createUIMessageStream` + `buildAhcStats` + telemetry sidebar plumbing — не трогается.

Tracker: см. `docs/decisions.md [2026-05-13] E0 — Single shared AHC-over-AI-SDK runtime`.

---

## Tool palette extensions (post-G3)

§1 Out жёстко зафиксировал "один `fetch_url` достаточно для MVP AHC демо". Эта секция —
roadmap расширения palette до "default agentic assistant" набора (`google_search`,
`create_image`) **после** того как G3 закрыт. Не G4; не блокирует acceptance gate;
fixes интент чтобы будущий агент не пере-открывал то же исследование.

### Current state (после G3 commit `aaf3cdc` + миграция `5ccbd96`)

User-facing tool — ровно один:

| Tool | Источник | Поведение |
|---|---|---|
| `fetch_url(url)` | `src/ui/lib/fetchUrl.ts:70-88` | HTTP GET → cheerio HTML→text, cap 8000 chars, timeout 5s, rate-limit 30/5 min per session |

Плюс AHC-injected `recall_tool_result` (`src/core/recallTool.ts`), который **не** user-facing
по смыслу — middleware подсовывает его модели когда scratchpad непуст, чтобы модель
доставала offloaded tool_result'ы по ссылке вместо повторного `fetch_url`.

System prompt (`src/ui/lib/systemPrompt.ts`) hardcoded под `fetch_url`. Если регистрировать
новые tools — обновлять prompt **обязательно**, иначе модель про них "не знает".

### Что добавить — gap analysis

| Tool | AHC-relevance | UX-relevance | Verdict |
|---|---|---|---|
| `google_search` | **+1.** Новый shape toxic tool_result (grounded ответ + цитаты, ~0.5-2 KB) → classifier видит более разнообразные траектории (`tool_heavy` чаще, `mixed`/`conversational` на чистых search'ах). Offload pipeline испытывается на другом контент-типе. | Default expectation для "research assistant"; убирает frustration "почему модель не может погуглить". | **Высокий приоритет** |
| `create_image` | Нейтрально. tool_result короткий (URL ~100 chars), не triggers T_SIZE-offload. Может быть offload-able только при reference-image input (base64 → ~50 KB) но AHC ради этого не запустится. | Image-out + image-edit с reference. Стандартная default-feature. | **Средний приоритет** |
| `browse_url` | Нулевая. Перекрывается с `fetch_url` (тот же HTTP GET + HTML→text). Различие появится только при JS-render через Playwright server-side — это +chromium процесс +1s latency, тяжеловес. | Lo-value alone. | **Скорее пропустить либо переименовать `fetch_url` → `browse_url`** (модели лучше отзываются на это имя). |

### Provider choice — оба tool'а через `@google/genai`, один ключ

**Ключевое наблюдение:** Gemini API имеет встроенный grounding-тул `tools: [{google_search:{}}]` —
модель сама ходит в Google, цитирует, отдаёт grounded ответ + `groundingMetadata` с
ссылками. Это **нативная фича провайдера**, не отдельный сервис. Тот же
`@google/genai` SDK покрывает и image generation (`responseModalities:["IMAGE"]`).
**Один ключ `GOOGLE_GENAI_API_KEY` → два tool'а** — без отдельного Brave/SerpAPI.

**Архитектурный nuance:** main actor в AHC-роуте остаётся `google/gemini-3-flash-preview`
через **OpenRouter** (для AHC middleware mount'а — обязательно). OpenRouter не
экспонирует Gemini native tools. Поэтому `google_search` и `create_image` —
**side-channel calls к Gemini API напрямую** из execute-body AI SDK tool'а; AHC
middleware видит результат как обычный `tool_result` (текст или URL) и offload'ит
как обычно. Архитектура остаётся чистой:

```
streamText({ model: AHC-wrapped OpenRouter Gemini-3-Flash, tools: { ... } })
                ▲                                          │
                │ main agent loop                          │ side-channel for tool exec
                │                                          ▼
        (AHC middleware                          @google/genai direct
         sees tool_result text)              ──► (google_search grounding OR
                                                  responseModalities:[IMAGE])
```

### Verification — ключ работает (2026-05-13)

Прогон против фактического `google.apiKey` из `jay-canvas/apps/platform/api/config/local.yaml`:

| Endpoint | `models?list` | `googleSearch` grounding | `responseModalities:[IMAGE]` |
|---|---|---|---|
| Direct: `https://generativelanguage.googleapis.com/v1beta` | HTTP 200 | HTTP 200 (5 grounding chunks, текст grounded) | HTTP 200 (476 KB PNG, корректный) |
| Gateway: `https://generativelanguage-gw.just-ai.com/v1beta` | HTTP 200 | HTTP 200 (3 grounding chunks) | not tested |

Ключ — "белый", direct API без IP allowlist'а. **Использовать direct endpoint** — без
зависимости от Just AI internal gateway. Gateway оставить как fallback.

### Source pointers — `/Users/Aleksei/Projects/jay-canvas`

Активные реализации в jay-canvas (по `apps/platform/api/src/functions/functions.list.ts`):

- **`google_search`** — в jay-canvas сейчас идёт через **Brave** (`functions.list.ts:22`
  регистрирует `BraveFunctions`; `SerpapiFunctions` существует в коде но
  `serpapi.apiKey: ""` — dead). Brave у них работает через прокси-gateway
  `https://brave-gw.just-ai.com`. **Для AHC переиспользовать не Brave-провайдер**, а
  нативный Gemini grounding (см. выше) — один ключ, один SDK, тот же effect.
- **`create_image`** — `apps/platform/api/src/functions/functions.google.ts` (200 строк).
  Wrapper над `@google/genai` SDK, модели Gemini Imagen (`gemini-2.5-flash-image`,
  `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`). Принимает
  `images: string[]` (max 3) — reference images для img2img/edit, fetched по URL +
  base64-inline в `contents`. Возврат — `{image_url}` после upload в FilesService.
  **Этот wrapper переносить — переиспользуемый паттерн.**

**Cred (один на оба tool'а):** `GOOGLE_GENAI_API_KEY` в `.env`. Значение — из
`jay-canvas/apps/platform/api/config/local.yaml` ключ `google.apiKey`. BaseURL —
**direct** `https://generativelanguage.googleapis.com/` (gateway не нужен).

### Что было сделано (2026-05-13)

**Implemented:** см. commit `feat(G): add google_search + create_image tools via @google/genai` (SHA backfill — см. `docs: backfill SHA` follow-up). Per-session rate limiters: `SEARCH_RATE_LIMITER` 20/5min, `IMAGE_RATE_LIMITER` 5/5min (`src/ui/lib/sessionRegistry.ts`).

- [x] **Recon** в jay-canvas: `apps/platform/api/src/functions/functions.google.ts` —
      image gen wrapper над `@google/genai` SDK. Brave-wrapper не читали (не
      переиспользуем — см. Provider choice выше).
- [x] **`pnpm add @google/genai`** в корневой `package.json`.
- [x] **Создан `src/ui/lib/googleGenai.ts`** — lazy singleton
      `new GoogleGenAI({apiKey: process.env.GOOGLE_GENAI_API_KEY!})` с
      `__resetClientForTests` для unit-тестов. BaseURL — default direct.
- [x] **Создан `src/ui/lib/googleSearch.ts`** — паттерн `fetchUrl.ts:76-88`.
      Возврат — `{ok, text, citations: [{title, uri}]}` (плоский shape из
      `groundingMetadata.groundingChunks[].web`). Модель `gemini-2.5-flash`.
      `SEARCH_RATE_LIMITER` 20/5min per session.
- [x] **Создан `src/ui/lib/createImage.ts`** — паттерн как `functions.google.ts`
      в jay-canvas, без NestJS / billing / FilesService.
      `client.models.generateContent({model:'gemini-2.5-flash-image', contents,
      config:{responseModalities:['IMAGE']}})`; decode `inlineData.data` base64,
      запись в **`src/ui/public/generated/<uuid>.png`** (а не data-URL — exit
      из localStorage bloat для chat history). Cleanup >1h при invoke.
      `IMAGE_RATE_LIMITER` 5/5min per session.
- [x] **Регистрация в `src/ui/app/api/chat/route.ts`:**
      `tools: { fetch_url, google_search, create_image }`.
- [x] **System prompt update в `src/ui/lib/systemPrompt.ts`** — упомянуты все три
      tools с when-to-use guidance.
- [x] **Image renderer** в `src/ui/components/Chat.tsx` — branch для
      `tool-create_image` + `output-available` → `<img src={output.image_url}>`;
      остальные tool-parts остаются JSON-блоком.
- [x] **Env var** в `.env`: `GOOGLE_GENAI_API_KEY=<value>` (gitignored).
      Значение — из `jay-canvas/apps/platform/api/config/local.yaml` `google.apiKey`.
      **Один ключ на оба tool'а.**
- [x] **Smoke**: Playwright MCP 3-turn trajectory (search → fetch citation → create_image),
      screenshots `/tmp/g-toolpalette-{1,2,3}.png`.

### Что НЕ менять при этом переносе

- **AHC middleware / scratchpad / offload pipeline** — toxic tool_result от search'а
  триггерит существующий A6 path без изменений; никаких core-доработок не требуется.
- **`createAhcRuntime`** — provider stays `'openrouter'`, model stays
  `google/gemini-3-flash-preview` (image gen идёт через **отдельный** SDK
  `@google/genai`, не через chat completion model).
- **`buildAhcStats` / telemetry envelope** — не зависит от количества tools; работает
  с любыми `compaction_event` / `recall_event` идентично.
- **`system_design.md §7 Track G phase plan`** — G1–G3 done; это **post-G3 expansion**,
  не отдельная фаза G4. Если расширение разрастётся (auth, sandbox для code interpreter,
  storage для files) — тогда уже отдельный design doc / трек.

### Hidden cost note

Каждый зарегистрированный tool добавляет JSON-schema в каждый запрос к модели —
эмпирически ~50-200 input tokens per schema. С 3 tools = ~+500 input tokens на каждый
turn baseline (до любого contenta). Для demo приемлемо; учитывать если будут
production-scale runs или benchmark sweeps.
