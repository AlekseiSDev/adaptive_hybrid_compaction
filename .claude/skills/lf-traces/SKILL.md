---
name: lf-traces
description: Extract and analyze Langfuse sessions/traces/spans for AHC sweep runs. Use when the user asks to look at Langfuse traces, sessions, or spans for a specific sweep / bench / config / task — e.g. "глянь трейсы прогона X", "почему упала задача Y", "что в Langfuse за последний час", "сравни прогоны X и Y", "топ дорогих задач в gaia", "какие тулзы дёргались". Also activates on "Langfuse", "трейсы", "сессии" mentions in analytical context.
user_invocable: true
---

# lf-traces — Langfuse data extraction & analysis for AHC

Use this skill when the user wants to inspect Langfuse trace data for AHC eval runs. It explains the project's session/trace/span hierarchy (B6 per `docs/design/B_eval-harness.md §9`), Langfuse REST API endpoints, and common query patterns. You compose the actual queries based on user intent — don't ship a fixed CLI, leverage `curl` + `jq` + `python3 -m json.tool` and `scripts/check-langfuse-hierarchy.ts` for structured checks.

## Hierarchy convention (B6)

- **Session** = `${bench}-${config_id}-${seed}` (one Langfuse session per sweep cell). `bench` ∈ {`gaia-med`, `lme-multiturn`, `longmemeval-med`, `locomo-med`, `tau-bench-retail-med`, `assistant-traj`, `synthetic`}. `config_id` = 16-hex hash deterministically derived from the config YAML row.
- **Trace** = one `eval.task` span = one dataset sample (root, `parentObservationId === null`).
- **Spans under trace** = `eval.turn × N` (multi-turn benches) + AI SDK auto-emitted `ai.generateText.*` / `ai.toolCall` (children). Tool spans show as **`type: 'TOOL'`** in Langfuse with name = the tool's own name (`web_search`, `visit_webpage`, etc.) — Langfuse renames them from `ai.toolCall` using the `ai.toolCall.name` attribute. Filter tools by `type === 'TOOL'`, never by name prefix.

## Auth & env setup

Always load `.env` before any curl: `set -a; source .env; set +a`. The relevant vars are `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Build the basic-auth header as:

```bash
AUTH=$(echo -n "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | base64)
```

If Langfuse isn't reachable (`curl: (7) Failed to connect to localhost port 3001`), check `docker ps --filter 'name=langfuse'` — if not running, suggest the user spin up `docker compose -f observability/docker-compose.yml up -d`. Don't auto-start it (`docker compose up` has side effects).

## REST endpoints (subset we use)

All under `${LANGFUSE_BASE_URL}/api/public/`:

- `GET /sessions?fromTimestamp=ISO&limit=50` → list sessions. **fromTimestamp filter looks at session activity, not creation — give a generous window (15-30 min) when looking for sessions from a run that finished < 1 min ago, otherwise some sessions silently drop out.**
- `GET /sessions/<sessionId>` → list traces in session (lightweight metadata).
- `GET /traces?fromTimestamp=...&sessionId=...` → trace list with filter. Supports `name`, `userId`, `tags` filters too.
- `GET /traces/<traceId>` → full trace with embedded observations array (each observation has `id`, `name`, `type` (`SPAN`/`GENERATION`/`TOOL`/`EVENT`), `parentObservationId`, `startTime`, `endTime`, `latency`, `totalCost`, `metadata`, `input`, `output`).
- `GET /observations?traceId=<id>&limit=50` → paginated observation list with richer attribute payload (used when `traces/<id>` truncates).
- `GET /observations/<observationId>` → single observation detail.

## Common workflows

### 1. "Глянь трейсы прогона X" / "summarize sweep X"

User gives a sweep name or partial identifier. Steps:

1. **Resolve to sessions.** Sweep names map to a 1:N session set — usually `${bench}-${configId}-${seed}` per cell. Two paths:
   - If the user names a specific sweep YAML (`smoke_hierarchy_gaia`), read the YAML to see which benches/configs/seeds it covers, then filter sessions by those (bench) prefixes.
   - If the user names a bench (`lme-multiturn`), list all sessions starting with `lme-multiturn-` in the time window.
   - If the user says "last run" / "недавний", use a 30-minute window and surface whatever comes back.
2. **For each session** fetch trace list, then per-trace details. Group by session.
3. **Output**: markdown table with columns `session_id | trace_count | total_cost | total_latency_s | errors`. If `--detail` or "подробно" — second table per session with `trace_id | task_id | turns | tool_calls | cost | status`.

Use `scripts/check-langfuse-hierarchy.ts --mode=hierarchy --bench=X --since-seconds=N` as a quick programmatic gate if the user wants "did it actually land". For data exploration, raw curl + jq is more flexible.

### 2. "Почему упала задача X" / "trace deep-dive"

1. Find the trace: filter `/traces?sessionId=...` by metadata or fetch the session's traces and grep by task_id (which is in trace `name` or input attributes).
2. `GET /traces/<id>` — inspect observations.
3. Look for observations with status code != OK, error events, or `metadata.error` non-null.
4. Walk the parent chain to show where in the agent loop the failure surfaced.

If the trace is an AHC run (config has `ahc_flags` non-empty), also surface compaction/recall events from the trace `input`/`output` or from records.ndjson on disk (`benchmarks/runs/<plan>/<bench>/<config_id>/<seed>/records.ndjson` — same `task_id`, has structured TurnRecord with `compaction_events`, `recall_events`).

### 3. "Топ дорогих / медленных задач" / "cost outliers"

Sort traces by `totalCost` or `latency` desc. Watch out: GAIA single-shot traces may have lower latency than LME multi-turn — compare within a bench, not across.

### 4. "Tool usage breakdown"

Aggregate observations with `type === 'TOOL'` by `name` across all traces in a session. Output a tool-name → count table. Useful for GAIA / tau-bench.

### 5. "Сравни прогоны X и Y"

Run workflow #1 on each, then compute deltas: cost ratio, turn-count distribution, success rate, tool usage. Format as side-by-side markdown columns.

## Output style

- Markdown tables for tabular data.
- Quote actual numbers (`$0.034 cost; 9 ai.toolCall; 3 traces`); don't paraphrase ("a few tool calls").
- Use the Langfuse UI URL format `${LANGFUSE_BASE_URL}/project/ahc/traces/<traceId>` so the user can click through.
- Keep summaries terse — if the user wants more, they'll ask for `--detail`.

## Don't

- Don't invent session IDs. Always fetch the list first.
- Don't paginate blindly — if `meta.totalItems > 50`, ask the user whether they want a wider scan or a tighter filter.
- Don't run live sweeps from this skill. If the user wants fresh data, point them at the sweep YAML + `scripts/eval.ts`.
- Don't write committed artefacts from this skill — output is for the conversation only. Per `feedback_experiments_not_in_git` memory, benchmark runs aren't versioned anyway.

## Reference snippets

```bash
# Setup (always first):
set -a; source .env; set +a
AUTH=$(echo -n "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | base64)
H="-H Authorization:Basic\ $AUTH -H Accept:application/json"

# List sessions in last 30 min.
# IMPORTANT: Langfuse fromTimestamp wants `...Z` suffix, NOT Python's default
# `+00:00` — the latter silently returns 0 sessions with no error.
SINCE=$(python3 -c "from datetime import datetime,timedelta,timezone; print((datetime.now(timezone.utc)-timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
curl -s -H "Authorization: Basic $AUTH" \
  "$LANGFUSE_BASE_URL/api/public/sessions?fromTimestamp=$SINCE" \
  | python3 -m json.tool

# Traces in one session:
curl -s -H "Authorization: Basic $AUTH" \
  "$LANGFUSE_BASE_URL/api/public/traces?sessionId=lme-multiturn-17e02d3b263d9a00-42" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(t['id'], t.get('name'), t.get('totalCost')) for t in d.get('data',[])]"

# Trace detail with observation summary by type:
curl -s -H "Authorization: Basic $AUTH" \
  "$LANGFUSE_BASE_URL/api/public/traces/<traceId>" \
  | python3 -c "
import sys, json, collections
d = json.load(sys.stdin)
obs = [o for o in d.get('observations', []) if isinstance(o, dict)]
by_type = collections.Counter(o.get('type') for o in obs)
tools = collections.Counter(o.get('name') for o in obs if o.get('type') == 'TOOL')
print('cost:', d.get('totalCost'), 'latency:', d.get('latency'))
print('by_type:', dict(by_type))
print('tools:', dict(tools))
"

# Quick hierarchy assertion (uses the project verifier):
pnpm tsx scripts/check-langfuse-hierarchy.ts \
  --bench=gaia-med --since-seconds=1800 \
  --expected-turns-min=0 --expected-tool-calls-min=1
```
