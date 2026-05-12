# Track G Design — Demo UI

> Track-level design для локального demo-приложения, которое оборачивает AI SDK v6 + AHC
> middleware и даёт interactive chat для defense / самопроверки. Phase plan —
> `system_design §7.2 Track G`.

---

## Meta

- **Track:** G (G1 skeleton → G2 AHC integration → G3 telemetry sidebar)
- **Wall-clock:** 3 дня
- **Зависит от:** A6 (AHC adapter) — UI без integration бесполезен; и от `ai-sdk-v6-surface`
  investigation (UI helpers — часть проверяемой surface area)
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
- Sidebar показывает live AHC state per response: `class`, `confidence`,
  `observations` count, `scratchpad` size, `recall_events`, `compaction_events`,
  active feature flags (§3 UI shape).
- Backend `/api/chat` route с AHC middleware mount'нутым над OpenRouter provider
  (Gemini-3.1-Flash default); scratchpad per-session in-memory с 1ч TTL (§4.G2).

**Demo (e2e):** UI **сам** и есть demo — `pnpm run dev:ui` открывает localhost,
пользователь ведёт multi-turn chat (image URL опционально), видит assistant response
+ AHC sidebar обновляется per response. Это deliverable для защиты; отдельного
demo-скрипта нет.

**Acceptance gate:** все три §4 exit criteria пройдены (G1 multi-turn chat работает
+ image URL передаётся; G2 AHC active, compaction events, recall tool работает;
G3 sidebar live updates per response) + ручной smoke на `localhost`: 10-turn
trajectory с tool-heavy фрагментом, sidebar показывает non-zero scratchpad и хотя
бы один recall event + UI не падает при provider 5xx mid-stream (§5 failure mode).

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **G1** | `src/ui/` Next.js skeleton с `/api/chat` (passthrough на OpenRouter, no AHC); chat panel + text + image URL input; multi-turn через `useChat` (AI SDK v6) | `pnpm run dev:ui` → localhost: отправить 3-turn chat с image URL во втором turn, убедиться что image рендерится и provider response приходит (§4.G1 Exit) |
| **G2** | AHC middleware mount'нут в `/api/chat`; feature flags из query params; per-session scratchpad `Map<sessionId, Scratchpad>` с TTL; recall tool инжектится когда scratchpad non-empty | `pnpm run dev:ui` → localhost с `?TYPE_AWARE_OFFLOAD=1`: 8-turn trajectory с heavy tool_result, в browser devtools network response видеть `compaction_event` и хотя бы один `recall_event` (§4.G2 Exit) |
| **G3** | Backend injects `ahc_stats` envelope в response; sidebar рендерит class/confidence/observations/scratchpad/recall list + feature flag indicators; updates per response | `pnpm run dev:ui` → localhost: 5-turn chat, после каждого assistant response sidebar обновляется (class меняется при tool-heavy turn'е, scratchpad size растёт, recall events list пополняется) (§4.G3 Exit). При отсутствии B2 sidebar показывает client-side state only (§5 failure mode) |

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
| **G1** Skeleton + AI SDK v6 chat | `investigations/ai-sdk-v6-surface.md` | G2 | §4.G1, §2 architecture, §3 UI shape | `Message`, `ContentPart` (text + image consumption) | end-to-end chat через UI, multi-turn, image URL передаётся (§4.G1 Exit) | §1 Scope (in/out boundary), §7 cost caps |
| **G2** AHC integration | G1, A6 | G3 | §4.G2, §2 architecture (middleware mount), §6 persistence policy | `FeatureFlags`, `Scratchpad` (per-session lifecycle) | AHC active, compaction events происходят, recall tool работает (§4.G2 Exit) | §5 failure modes (scratchpad TTL, rate-limit), §7 cost / abuse |
| **G3** Telemetry sidebar | G2, B2 (telemetry stream contract — см. `B_eval-harness.md §9.6`) | — | §4.G3, §3 UI shape (sidebar panel) | `TrajectoryClass`, `Observation`, `PointerPlaceholder` (read-only, для display) | live AHC stats обновляются per response, видно class/confidence/observations/scratchpad/recall (§4.G3 Exit) | §5 failure modes (provider 5xx mid-stream), `B_eval-harness.md §9` observability |

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
  - Sidebar показывает live AHC state: detected class, observation count, scratchpad size,
    recall events
  - Backend API route → AHC adapter → OpenRouter (Gemini-3.1-Flash default)
- **Out**:
  - User auth / multi-user
  - Image upload (только URL — урезает scope на storage/multipart)
  - Server-side persistence; browser-only state (см. `system_design §11.3`)
  - Production-grade UX (mobile, accessibility) — basic styling достаточно
  - Streaming markdown edge cases — simple text/code blocks ok; tables/KaTeX out

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
│  [ text input              ] [Send]  │  flags:               │
│  [ image URL (optional)    ]         │  [x] TASK_AWARE       │
│                                       │  [x] TYPE_AWARE       │
│                                       │  [ ] REFLECTION       │
└─────────────────────────────────────┴───────────────────────┘
```

Sidebar обновляется по telemetry events возвращаемым с каждым assistant response.
Feature flag toggles — query params, перезагружают session.

---

## 4. Phase breakdown

### G1. Skeleton + AI SDK v6 chat (1 день)

- Next.js App Router project в `src/ui/` (collocated, single package.json).
- API route `/api/chat` без AHC — just OpenRouter passthrough.
- Image URL input — UI поле; конвертится в `{type:'image', mimeType, data:<url>}`
  ContentPart перед отправкой.
- Verify: AI SDK v6 UI helpers (`useChat` или equivalent) работают с OpenRouter provider —
  закрывается в `ai-sdk-v6-surface` investigation (см. A6 prerequisite в `system_design §7.2`).
- **Exit**: можно поговорить с моделью через UI; multi-turn; image URL передаётся.

### G2. AHC integration (1 день)

- Mount AHC middleware над provider в `/api/chat`.
- Feature flags из query params (для quick toggling в demo: `?TYPE_AWARE_OFFLOAD=0`).
- Scratchpad lifecycle: per-session, in-memory `Map<sessionId, Scratchpad>` в API process.
  `sessionId` — uuid в browser localStorage, передаётся в request header.
- Eviction: scratchpad drop'ается после 1ч idle (in-memory TTL).
- **Exit**: AHC active, compaction events происходят, recall tool работает.

### G3. Telemetry sidebar (1 день)

- Backend injects AHC stats в response (JSON envelope `{message, ahc_stats}` или SSE event).
- Frontend sidebar отображает live: class, confidence, observations count,
  scratchpad size, recall events list, current feature flags.
- **Exit**: во время разговора видно как AHC компактит — основная demo-ценность.

---

## 5. Failure modes

| Mode | Mitigation |
|---|---|
| AI SDK v6 UI helpers unstable / breaking | Fallback на manual fetch + SSE; investigation prerequisite |
| OpenRouter rate-limit на demo | Per-session rate-limit info shown в UI; clear error message |
| Image URL не загружается (CORS / 404) | Validate URL before send; show inline error |
| Scratchpad растёт без cleanup | TTL eviction 1ч idle |
| Provider 5xx mid-stream | Show error inline, keep history; allow retry last user msg |

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
