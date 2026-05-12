# Observability — Langfuse self-hosted (B2)

Local Langfuse v3 stack для inspect AHC-traces during dev / interactive demo. Полностью
opt-in: `verify.sh` и main sweep'ы (E1/E2) работают без поднятого Langfuse, нулевой
overhead на disabled пути (см. `src/eval/observability/langfuse.ts`).

## Quick start

```bash
docker compose -f observability/docker-compose.yml up -d
# Wait ~30s for healthchecks; then visit http://localhost:3001
```

В UI:

1. Регистрируешь user (only first run).
2. Создаёшь Project — копируешь Public Key + Secret Key.
3. Экспортируешь env vars:

```bash
export LANGFUSE_ENABLED=true
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_BASE_URL=http://localhost:3001
```

4. Прогоняешь vertical-slice smoke (требует `OPENROUTER_API_KEY`):

```bash
OPENROUTER_API_KEY=sk-... pnpm tsx scripts/eval.ts \
  --sweep eval/sweeps/smoke_full_context.yaml
```

5. Trace появляется в Langfuse UI на проекте.

## Stop / wipe

```bash
docker compose -f observability/docker-compose.yml down       # stop, keep data
docker compose -f observability/docker-compose.yml down -v    # wipe volumes
```

Данные (`postgres`, `clickhouse`, `clickhouse-logs`, `minio`) хранятся в
`observability/data/<service>/` — путь gitignored.

## Env vars (consumed by `src/eval/`)

| Var                     | Default                      | Notes                                                                                |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `LANGFUSE_ENABLED`      | unset → `false`              | Master switch; `true` подключает `LangfuseSpanProcessor`                             |
| `LANGFUSE_PUBLIC_KEY`   | —                            | Required when `LANGFUSE_ENABLED=true`                                                |
| `LANGFUSE_SECRET_KEY`   | —                            | Required when `LANGFUSE_ENABLED=true`                                                |
| `LANGFUSE_BASE_URL`     | `https://cloud.langfuse.com` | Self-hosted: `http://localhost:3001`                                                 |
| `OPENROUTER_API_KEY`    | —                            | Required для `baseline: full_context` (vertical slice)                               |

## Compose file structure (6 services)

- `langfuse-web` (port 3001 → host) + `langfuse-worker` — Langfuse v3 server
- `postgres:17` — auth/users/projects metadata
- `clickhouse:24.12-alpine` — trace storage
- `redis:7` — queue / pubsub
- `minio` — S3-compatible blob storage для events

Default credentials в compose файле — INSECURE plaintext, для localhost dev only.
Меняй для anything beyond localhost.

## Schema upgrade policy

Pin `langfuse:3` + `langfuse-worker:3` (per `B_eval-harness.md §9.5`). Upgrade — отдельная
investigation в `docs/investigations/`.

## Failure modes (см. `B_eval-harness.md §9.5`)

| Symptom                                      | Likely cause                                       |
| -------------------------------------------- | -------------------------------------------------- |
| `LANGFUSE_ENABLED=true ... but ... missing`  | Забыл export PUBLIC/SECRET keys                    |
| Trace не появляется                          | Worker не запущен / clickhouse healthcheck failing |
| Compose не поднимается                       | Port 3001 занят / docker daemon down               |
| Langfuse UI не подгружается                  | `langfuse-web` не доделал миграции (~30s startup)  |
