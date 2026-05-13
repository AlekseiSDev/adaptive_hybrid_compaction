# Observability — Langfuse self-hosted (B2)

Local Langfuse v3 stack для inspect AHC-traces during dev / interactive demo. Полностью
opt-in: `verify.sh` и main sweep'ы (E1/E2) работают без поднятого Langfuse, нулевой
overhead на disabled пути (см. `src/eval/observability/langfuse.ts`).

## Quick start (zero-touch, B4)

```bash
docker compose -f observability/docker-compose.yml up -d
# Wait ~30s for healthchecks (postgres + clickhouse + redis + minio); ~30s more
# for langfuse-web init migrations. После этого:
#   - UI на http://localhost:3001 (login dev@ahc.local / ahc-dev-CHANGEME)
#   - REST API доступен; pk/sk pre-created по LANGFUSE_INIT_* в compose.
```

`.env.example` уже содержит deterministic dev keys, matching `LANGFUSE_INIT_*` в
compose:

- `LANGFUSE_PUBLIC_KEY=pk-lf-ahc-dev-deterministic`
- `LANGFUSE_SECRET_KEY=sk-lf-ahc-dev-deterministic`

Никакой UI walk не требуется — `cp .env.example .env.local` достаточно. Production /
shared deployments — override keys в `.env.local` (gitignored).

Прогоняешь vertical-slice smoke (требует `OPENROUTER_API_KEY` в `.env.local`):

```bash
set -a && source .env.local && set +a
LANGFUSE_ENABLED=true pnpm tsx scripts/eval.ts \
  --sweep eval/sweeps/smoke_full_context.yaml
```

End-to-end verification (B4 acceptance gate):

```bash
pnpm tsx scripts/check-langfuse-trace.ts --since-seconds=60
# exit 0 + печатает trace_id/observation_count если ≥ 1 trace доехал.
```

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
