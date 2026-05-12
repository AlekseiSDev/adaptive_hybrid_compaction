# Investigation: Mastra storage adapter choice for C1

## Meta

- **Date Created:** 2026-05-13
- **Date Updated:** 2026-05-13
- **Status:** Completed
- **Related:** `design/C_baselines.md §4.1` (storage options), `system_design.md §11.3`
  (persistence policy — testcontainers PG mentioned for Mastra), `decisions.md`
  (will add C1 storage entry post-this-investigation), Track C plan
  `~/.claude/plans/cozy-greeting-acorn.md`

## Goal

C1 (`MastraOMBaseline`) требует Mastra `Memory` со storage adapter'ом. Design doc
оставлял два варианта open — PG via testcontainers (Docker required) или SQLite (если
exposed в `@mastra/core` v6.x). Цель — verify фактическое npm-состояние Mastra-пакетов
на 2026-05-13 и зафиксировать конкретный pin для C1.

## Problem Statement

- **Observation:** `design/C_baselines.md §4.1` упоминает `@mastra/core` v6 как baseline,
  но v6 — это не Mastra version, а AI SDK version. Реальная Mastra major'а нужно
  verify в момент C1.
- **Manifestation:** package.json пока без `@mastra/*` deps; storage path определяет
  whether testcontainers+pg добавляем в devDeps и whether интеграционный тест
  C1 marked skip-on-no-Docker.
- **Why a problem:** SQLite-in-process даёт CI runs без docker dep + faster (~0s startup
  vs ~1s per task на testcontainers). Docker dep на CI/dev box — known failure mode
  (см. C_baselines.md §4.4).
- **Known facts:** Mastra репо on GitHub, paper-time snapshot (codex#14589) ссылается
  на Mastra memory layer; observational memory был дефолтным паттерном.

## Scope

- **In scope:** verify latest stable Mastra package set on npm; resolve SQLite-vs-PG;
  fix Node engine compatibility if нужен bump.
- **Out of scope:** Mastra API shape для `agent.generate()` (резолвится при C1 imp);
  Mastra observability hooks (отдельный topic — Track G).
- **Constraints:** real C1 ship — within 2 days wall-clock per design.

## Hypotheses

| ID | Hypothesis | Why plausible | How to validate | Status |
|---|---|---|---|---|
| H1 | Mastra latest major = 6 per design assumption | Design wrote "Mastra v6" verbatim | `npm view @mastra/core version` | rejected |
| H2 | Mastra latest stable = 1.x, multiple major'ов ещё не было | Mastra young framework (<2 years per GitHub) | same | confirmed |
| H3 | SQLite/LibSQL storage adapter exists в Mastra ecosystem | Common pattern в Node fw'ах | `npm search '@mastra/'` + view descriptions | confirmed |
| H4 | `@mastra/libsql` works in-process без docker dep | LibSQL = SQLite fork by Turso, embedded mode supported | check `@mastra/libsql` description / peerDeps | confirmed |
| H5 | Node ≥22.0.0 engine spec проекта совместима с Mastra latest | package.json engines заявлено | `npm view @mastra/core engines` | needs bump |

## Evidence

```
$ npm view @mastra/core version
1.32.1

$ npm view @mastra/core versions --json | tail -5
... "1.32.1", "1.33.0-alpha.0", ... "1.33.0-alpha.16"

$ npm search '@mastra/'
@mastra/core            1.32.1   (framework для AI-powered apps)
@mastra/memory          1.17.5   (Memory management для agents)
@mastra/libsql          1.10.0   (Libsql provider — vector + db storage)
@mastra/pg              1.10.0   (Postgres provider — vector + db storage)
@mastra/dynamodb        1.0.6    (DynamoDB storage adapter)
@mastra/deployer        1.32.1
@mastra/observability   1.11.1
@mastra/server          1.32.1
@mastra/express         1.3.18

$ npm view @mastra/core engines peerDependencies
engines = { node: '>=22.13.0' }
peerDependencies = { zod: '^3.25.0 || ^4.0.0' }

$ npm view @mastra/libsql peerDependencies
peerDependencies = { '@mastra/core': '>=1.32.0-0 <2.0.0-0' }

$ npm view @mastra/memory peerDependencies
peerDependencies = { zod: '^3.25.0 || ^4.0.0', '@mastra/core': '>=1.4.1-0 <2.0.0-0' }

$ node --version
v22.17.0   # local dev — uses .nvmrc / system default; CI matrix должен проверить

Current package.json:
  engines.node: ">=22.0.0"
  dependencies.zod: "^4.4.3"   ✓ matches peer dep ^3.25 || ^4.0
```

## Findings

| Source | Result | Confidence | Notes |
|---|---|---|---|
| `npm view @mastra/core version` | latest stable = `1.32.1` (2026-05-05) | high | Design's "v6" reference was wrong (likely confused с AI SDK v6) |
| `npm search '@mastra/'` | LibSQL + PG + DynamoDB providers все exposed; both vector+db storage | high | `@mastra/libsql` — SQLite-compatible, embedded |
| LibSQL = SQLite по сути | LibSQL Turso fork — same SQL dialect, file-based embedded mode | high | Confirmed by Turso/LibSQL docs (cross-checked) |
| Node engine | Mastra wants `>=22.13.0`, проект — `>=22.0.0` | high | Bump engines.node до `>=22.13.0` |
| Peer dep zod | `^3.25 || ^4.0`, проект `^4.4.3` | high | OK |

## Interpretation

- **H1 rejected, H2 confirmed.** Mastra latest stable = `1.32.1`. Design doc упоминание
  "v6" — terminology conflict с AI SDK v6, не Mastra version.
- **H3 + H4 confirmed.** `@mastra/libsql@1.10.0` — full storage provider, embedded,
  без external service. Sweet spot: SQLite ergonomics + Turso production-grade engine.
- **H5 needs action.** Node engine bump 22.0.0 → 22.13.0; minor change, доступно
  локально (v22.17.0 уже установлен) и на CI (если используем Node 22 LTS).

**Why LibSQL вместо raw SQLite (`better-sqlite3` / similar):** Mastra экспозит
storage interface через свои provider пакеты — нет SQLite-direct adapter, только
LibSQL. LibSQL = drop-in замена SQLite с теми же гарантиями + поддержка remote
(libsql server) если когда-то понадобится. Для MVP — embedded file mode.

**Why не PG via testcontainers:** Docker dependency на CI/dev box. Avoided когда
SQLite-class option exists.

**Why не Mastra direct Memory без storage:** `@mastra/memory@1.17.5` peer dep
обязывает `@mastra/core`, который ожидает storage через provider — нельзя skip.

## Next Actions

- **Action:**
  1. Bump `engines.node` в `package.json` до `>=22.13.0`.
  2. Добавить deps (pinned без caret per design §4.2 deterministic replay):
     - `@mastra/core@1.32.1`
     - `@mastra/memory@1.17.5`
     - `@mastra/libsql@1.10.0`
  3. C1 imp использует `LibSQLStore({ url: 'file:./.mastra/c1_${task.id}.db' })`
     (in-process file per task; `finalize()` rm-rf'ит file).
  4. `verify.sh` → integration test для C1 NOT added в `test:unit` (real LLM call
     + filesystem), запускается как explicit `test:integration:mastra` sub-command,
     skip-marked если `OPENROUTER_API_KEY` отсутствует.

- **Verification:** `pnpm exec vitest run src/eval/baselines/mastra_om.test.ts`
  с `OPENROUTER_API_KEY` set → step()-roundtrip + thread_id persistence assertions pass.

- **Decision entry (`decisions.md`):**
  ```
  - **[2026-05-13] C1 — Mastra storage adapter: `@mastra/libsql` (embedded SQLite-class), Mastra pin `1.32.1`**: Investigation `docs/investigations/mastra-storage.md` reject'ил design assumption "Mastra v6" (latest stable = `1.32.1`); LibSQL provider exposes embedded file-based storage без Docker dependency. Альтернатива (PG via testcontainers) — отвергнута due to Docker dep + ~1s/task overhead. Pins (no caret per `design §4.2`): `@mastra/core@1.32.1`, `@mastra/memory@1.17.5`, `@mastra/libsql@1.10.0`. Node engine bump `>=22.0.0` → `>=22.13.0`. Cleanup: file per task `./.mastra/c1_${task.id}.db`, rm-rf в `finalize()`.
  ```

- **Harness entry:** Не требуется — это one-off исследование, не повторяющаяся ошибка.
