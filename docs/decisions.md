# Decision Log

> Append-only лог архитектурных и design-решений, принятых в ходе реализации.
> Новые записи — внизу. Не редактируем и не удаляем прошлые; если решение реверсится,
> добавляем новую запись с `Supersedes:` на старую.

## Format

```
- **[YYYY-MM-DD] Title**: Что решили. Почему. [Supersedes: YYYY-MM-DD Title, если применимо]
```

## Pre-existing decisions

Зафиксированы в [`system_design.md §8`](system_design.md#8-Принятые-решения). Не дублируем
здесь — при ссылке указываем "see system_design §8".

## Decisions

<!-- append new entries below as work progresses -->

- **[2026-05-13] Track G — Demo UI добавлен в MVP**: Local-only Next.js app, text + image URL input, single-user, no auth. Цель — "ассистентская обвязка которой пользуешься" deliverable + interactive demo на защите. Scope — 3 дня wall-clock (G1 skeleton, G2 AHC integration, G3 telemetry sidebar); зависит от A6. Полный design — `design/G_ui.md`.

- **[2026-05-13] Observability — self-hosted Langfuse встроен в Track B (не отдельный трек)**: B2 расширен на `docker-compose.yml` + AI SDK v6 OpenTelemetry exporter. Opt-in через `LANGFUSE_ENABLED=true`; runs работают без Langfuse если он не поднят. Track G UI consume'ит тот же telemetry поток. Полный design — `design/B_eval-harness.md §9`.

- **[2026-05-13] Persistence policy MVP — in-memory + browser localStorage only**: AHC scratchpad in-memory (`Map<sessionId, Scratchpad>`, TTL 1ч idle), UI state в browser localStorage, eval harness — NDJSON на диск. Mastra OM baseline использует ephemeral PG via testcontainers — изолированно. **Нет Postgres / SQLite в основном слое.** Если post-MVP появится need в durable session restore — `better-sqlite3` (SQLite), не Postgres. Rationale: §2.2 non-goals + scope не требует. Restart support — browser replay из localStorage.

- **[2026-05-13] Token counting source — provider response headers, не offline tokenizer**: OpenRouter `usage.{prompt_tokens,completion_tokens}` для main actor (Gemini-3.1-Flash); Anthropic direct `usage.*` для cache-hit subset E3. NDJSON хранит provider-reported counts как authoritative; Langfuse — secondary consumer того же event stream через AI SDK v6 OpenTelemetry adapter, не считает токены сам. Не используем `@anthropic-ai/tokenizer` или аналоги — для не-Anthropic моделей они дают wrong numbers. Resolves open question 1 из `design/B_eval-harness.md`.

- **[2026-05-13] Vendored upstream snapshot — `references/` directory**: Скопированы `paper.pdf` + LaTeX source + `refs.bib` + mle-harness код (12 .py) + NDJSON/summaries в `references/`. Source — `~/Projects/ai_scientists/Holosophus/workdir/compaction_policies__20260508_0231/` (timestamp 2026-05-08 02:31). Snapshot, не submodule: upstream — workdir внешнего проекта (Holosophus AI scientist), не отдельный git repo; новые версии re-copy целиком, не cherry-pick. Подтянуто из-за зависимости в `design/B_eval-harness.md` Meta + `system_design §7.2 B1` (port source) + `design/F_report.md §4.1` (cite source). Размер ~1.8 MB, в git без LFS. Policy и layout — `references/README.md`.

- **[2026-05-13] Package manager — pnpm**: pnpm@10.26.1, зафиксирован `packageManager` field в `package.json`. Причина: строгий node_modules layout ловит запрещённые import-направления (`core → adapters`) раньше плоского npm tree до момента, когда мы поднимем `eslint-plugin-boundaries` (per CLAUDE.md Harness Rules — добавим при первом нарушении); деривативно — workspaces, если позже разнесём `src/core` / `src/adapters` / `src/eval` / `src/ui` по пакетам. Fallback: npm работает на том же `package.json` без потерь, если pnpm станет блокером CI/devbox.

- **[2026-05-13] A1 cache-invariance test — JSON.stringify как temporary bytewise proxy**: в A1 ещё нет ни `compact()`, ни `serializeForCache()`, поэтому §9.1 контракт проверяется структурно: `JSON.stringify(tierize(h_i).tier1) === JSON.stringify(tierize(h_{i+1}).tier1)` плюс trivial-stability assertion на пустой Tier-2 (`observations=[]`, `pointers=[]`). A2 заменит на explicit `serializeForCache(prefix): Uint8Array` и перепишет тест на честный bytewise check. Сейчас proxy достаточен — Tier-1 формируется детерминированно из неизменных messages в `tierize()`, JSON.stringify даёт каноничную форму при одинаковом property-order (контролируем в конструкторе). Follow-up для A2 зафиксирован в `docs/implementation/A1.md` Risks.

- **[2026-05-13] AtomicGroup non-null tool_result, InflightToolUse — отдельный тип**: канонический `AtomicGroup` (`design/A_ahc-algorithm.md §2.4`) держит `tool_result: Message` non-null. Tool_use без матчующего tool_result разъезжается в отдельный `InflightToolUse = { group_id, tool_use, turn_index }`. Причина: `tool_result: null` в core-контракте размывает атомарность (которая по §5.1 — invariant группы); потребители `AtomicGroup` (offloader в A2, digest §5.3) полагаются на non-null. Отклонение от verbatim §2.4 — там `Tier3.inflight: AtomicGroup[]`; в нашей имплементации `Tier3.inflight: InflightToolUse[]`. Синхронизация design doc — отдельным PR при следующем редактировании §2.4.

- **[2026-05-13] A4 hysteresis state — caller-owned, bidirectional, threshold=2**: `classifyWithHysteresis(features, prevState?): { class, newState }` — pure функция; `HysteresisState = { lastClass, pendingClass | null, pendingCount }`. Смена класса требует **2 последовательных turn'a** с тем же candidate (§3.2 verbatim), bidirectional (любая пара класса). Когда candidate ломает streak (intermediate turn с третьим классом) — counter сбрасывается и стартует новый pending. State хранит вызывающая сторона (A6 будет lay it рядом с `Tier2.classSignal`); core stateless, что упрощает testability и сохраняет cache-friendly семантику (state меняется только при флипе). Hysteresis threshold вынесен в внутреннюю константу `HYSTERESIS_THRESHOLD=2`, calibratable в E без contract change. Open question §9.1 "2 turns достаточно или больше" остаётся для M1 калибровки.
