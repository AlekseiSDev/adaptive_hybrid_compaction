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
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: plan-mode
разбивает фазу на task'и, прогресс трекается через TaskCreate / `implementation/<phase>.md`
по `templates/implementation_template.md`. Pseudocode и контракты остаются в design
doc как source of truth, не дублируются в implementation.

---

## 1. Scope

- **In**:
  - Single-page Next.js (App Router) chat UI, runnable locally (`npm run dev:ui`)
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
