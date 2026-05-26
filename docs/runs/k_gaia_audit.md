# Track K — `gaia-med` bench audit

> Generated 2026-05-26. Track K execution per `docs/design/K_gaia.md`.
> Closes cross-domain agentic gap in eval-protocol (4 benches → 5;
> tau-bench-retail-med узкоdomain retail, GAIA cross-domain research +
> web + code + multimodal).
>
> Peer companion to `e_sweep_audit.md` + `h_followup_audit.md` +
> `i_mastra_agent_audit.md`. F-report consumes this audit для cross-bench
> Pareto plot (5-я точка).
>
> **Status (2026-05-26):** K1–K3 + SearXNG + K-tail competitor sweep
> complete. **K-tail run**: 2 baselines × n=25 × seed=42, $1.87 total
> spend, status=complete, err_rate=0%. `gaia_bench_agent` (FC analog)
> acc=**0.32**; `mastra-agent` (Mastra Memory) acc=**0.16**. K-tail
> integration added `mastra-agent` × `gaia-med` dispatch (Track K
> §5.2 — был text-fallback без tools раньше).

---

## Scope

1 bench (`gaia-med`), n=25 effective (5/30 attachment tasks filtered at
bake — xlsx/pdf/pdb/jsonld/docx not vendored; Medium scope per design
§7 Q5).

**K-tail competitor sweep** (`main_e1_gaia_competitors.yaml`, executed
2026-05-26):
- `gaia_bench_agent` (config_id `1dcd84ecc73b608c`) — vanilla agent с
  GAIA tools, no AHC. FC analog для agentic bench.
- `mastra-agent` (config_id `e55d32e046e6b5cc`) — Mastra Agent +
  Memory + LibSQL + GAIA tools. Framework competitor.

**Other planned configs** (not in this run, deferred):
- `gaia_bench_agent_ahc` — AHC variant (`main_e1_gaia.yaml`, отдельный
  run).

Seeds: 42. Budget cap: $30 (`main_e1_gaia_competitors.yaml`).

---

## Smoke validation (K3+SearXNG live, 2026-05-26)

```
docker compose -f observability/searxng-docker-compose.yml up -d
set -a && . ./.env && set +a
WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml \
  --max-tasks-per-cell=5 --concurrency=1
```

| bench | baseline | n | acc | cost_$ | err_rate |
|---|---|---|---|---|---|
| gaia-med | gaia_bench_agent | 5 | **0.80** | 0.187 | 0% |

**Per-task breakdown:**

| task_id | level | acc | cost_$ | answered | ground_truth |
|---|---|---|---|---|---|
| gaia_000 | 2 | 1.0 | 0.040 | `egalitarian` | `egalitarian` ✓ |
| gaia_001 | 2 | 1.0 | 0.018 | `34689` | `34689` ✓ |
| gaia_002 | 2 | 0.0 | 0.056 | `Final answer: 1` | `41` ✗ (arithmetic miss) |
| gaia_003 | 2 | 1.0 | 0.017 | `backtick` | `backtick` ✓ |
| gaia_004 | 1 | 1.0 | 0.055 | `17` | `17` ✓ |

**Findings:**
- **4/5 correct на n=5**; SearXNG → arxiv/USGS/wikipedia → actor → grader
  пайплайн полностью функционален.
- **80% acc** — высокий результат относительно ожидания (Holosophus
  reports ~60% on similar setup); n=5 sample size небольшой,
  variance widely possible на full n=25.
- **4/5 ответов без "Final answer:" prefix** — actor возвращает голый
  токен ("egalitarian", "17", etc.) после tool-call chain. Grader
  fallback на full-text normalization (per K_gaia.md §3.1) handle'ит
  правильно, score=1.0 благодаря normalization.
- **Единственный fail (gaia_002)**: задача требовала арифметики
  «p-value 0.04 × N papers где false positive» — actor использовал
  "Final answer: 1" но ground truth 41. Search вернул контекст, но
  reasoning miss. Не пайплайн bug, а capability ceiling gpt-5.4-mini.

**Pipeline checks (вшитые в K3 acceptance):**
- ✓ `defaultAdapterRegistry.resolve('gaia-med')` returns gaiaAdapter + gaiaGrader.
- ✓ `defaultRunnerRegistry.resolve` routes к `resolveGaiaRunner`.
- ✓ AI SDK v6 `generateText({tools, stopWhen: stepCountIs(20)})` driving multi-step ReACT.
- ✓ `gaiaGrader` pure-normalization (no LLM-judge invoked).
- ✓ SearXNG `http://localhost:8080/search?format=json` отдаёт ≥1 result/query.
- ✓ status=complete, err_rate=0%.

---

## Headline numbers (K-tail competitor sweep, n=25, seed=42)

```
docker compose -f observability/searxng-docker-compose.yml up -d
docker compose -f observability/docker-compose.yml up -d  # langfuse
set -a && . ./.env && set +a
LANGFUSE_ENABLED=true WEB_SEARCH_AUTOSELECT=true \
  SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/eval.ts \
  --sweep eval/sweeps/main_e1_gaia_competitors.yaml --concurrency=4
```

| baseline | n | acc | cost_$ | $/task | input_tok | output_tok | err_rate |
|---|---|---|---|---|---|---|---|
| `gaia_bench_agent` | 25 | **0.320** | 1.347 | 0.054 | 1 715 589 | 13 450 | 0% |
| `mastra-agent` | 25 | 0.160 | 0.525 | 0.021 | 587 895 | 18 694 | 0% |

Total sweep: $1.87, wall-clock ≈ 17 min (concurrency=4).

### Per-level breakdown

| level | n | gaia_bench_agent acc | mastra-agent acc |
|---|---|---|---|
| 1 (easy) | 7 | **4/7 = 0.57** | 1/7 = 0.14 |
| 2 (medium) | 14 | 4/14 = 0.29 | 3/14 = 0.21 |
| 3 (hard) | 4 | 0/4 = 0.00 | 0/4 = 0.00 |

Findings:
- **Vanilla 2× over Mastra on acc** (0.32 vs 0.16). Mastra Memory
  compaction trades accuracy for cost.
- **Mastra 2.57× cheaper per-task** ($0.021 vs $0.054). Memory
  drastically reduces input-tokens read (587K vs 1.7M → 2.9× fewer)
  but doesn't translate to better accuracy на single-shot GAIA.
- **Both fail level-3 completely** (0/4). gpt-5.4-mini capability
  ceiling, not pipeline limitation. Hard tasks need multi-step
  research chains that exceed actor's depth.
- **Mastra weakest on level-1** (1/7) — counterintuitive. Memory
  injection ломает short ReACT chains для simple lookups.

### Per-tool usage distribution

Across 25 vanilla traces (from Langfuse, B6 telemetry):

| tool | calls | % |
|---|---|---|
| `web_search` | 307 | 86% |
| `visit_webpage` | 36 | 10% |
| `python_exec` | 15 | 4% |
| `text_editor` | 0 | 0% |
| `describe_image` | 0 | 0% |

Total 358 tool_calls across 25 tasks (mean 14.3 calls/task). Heavy
search reliance; `text_editor` + `describe_image` unused — no preloaded
files, no images in n=25 subset.

Mastra session: 0 tool_calls visible через Langfuse (см. §Langfuse
verification — Mastra opaque limitation).

---

## Langfuse verification (B6 traces, lf-traces skill)

Per `.claude/skills/lf-traces/SKILL.md`. Both sweep sessions persisted
с B6 hierarchy (eval.task root + AI SDK auto-spans).

| session | traces | total observations | type breakdown |
|---|---|---|---|
| `gaia-med-1dcd84ecc73b608c-42` (vanilla) | 34* | 787 | 65 SPAN + 358 TOOL + 364 GENERATION |
| `gaia-med-e55d32e046e6b5cc-42` (mastra-agent) | 25 | 25 | 25 SPAN only |

\*Vanilla session has 34 traces vs 25 records — includes 9 traces from
smoke runs in prior sessions (same config_id → same session ID, append
across runs). Не bug, history artefact.

**Limitation: Mastra opaque to Langfuse.** `mastra-agent` traces show
only the eval.task root — Mastra's internal ReACT loop (model →
tool_call → execute → tool_result) НЕ emit AI SDK auto-spans because
`@mastra/core` doesn't expose `experimental_telemetry` option (only
generic `modelSettings`). Tool calls happen — visible через NDJSON
totals — but не attributable per-tool in Langfuse без custom Mastra
instrumentation. **Action for F-report**: cite Mastra tool counts
from NDJSON, not Langfuse.

**Cost rollup in Langfuse = $0** на trace-level: AI SDK auto-spans
не set `cost_details` attribute by default (OpenRouter model prefixes
не в Langfuse built-in pricing table). NDJSON cost authoritative
($1.87 sum). Future polish: thread cost через OTel attribute (B6+).

Reproduction:
```bash
pnpm tsx scripts/check-langfuse-hierarchy.ts \
  --bench=gaia-med --since-seconds=1800 --expected-tool-calls-min=1
# expect FAIL on Mastra config (no ai.toolCall); PASS on vanilla.

AUTH=$(echo -n "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | base64)
curl -s -H "Authorization: Basic $AUTH" \
  "$LANGFUSE_BASE_URL/api/public/traces?sessionId=gaia-med-1dcd84ecc73b608c-42&limit=100"
```

UI links (local Langfuse):
- vanilla: `http://localhost:3001/project/ahc/sessions/gaia-med-1dcd84ecc73b608c-42`
- mastra: `http://localhost:3001/project/ahc/sessions/gaia-med-e55d32e046e6b5cc-42`

---

## Implementation summary (K1–K3)

| Phase | Files | Tests |
|---|---|---|
| **K0** preflight | `references/gaia/{data,README.md}` (snapshot + license note) | n/a (vendoring) |
| **K1** scaffold | `scripts/bake-gaia.ts`, `src/eval/adapters/gaia-med.{ts,schema.ts}`, `benchmarks/gaia/{tasks/*,README.md}` | 27/27 grader+adapter unit tests |
| **K2** 5 tools | `src/eval/adapters/gaia-tools/{web-search,visit-webpage,text-editor,python-exec,describe-image,index}.ts` | 27/27 per-tool unit tests (mocked + live-gated) |
| **K3** runner+dispatch | `src/eval/adapters/gaia-med/{agent-runner.ts,index.ts}`, edits в `src/eval/types.ts` (+`'gaia-med'` literal), `src/eval/runner.ts` (adapter + runner dispatch) | 6/6 runner unit tests (mocked `generateText`) |

`./scripts/verify.sh all` green throughout — 693 unit tests + 5
cache-invariance tests pass.

---

## Key design decisions (cross-link)

1. **Pure-normalization grader** (no LLM judge) — `decisions.md
   2026-05-22`. Trade-off: faithful to Mialon et al. + cheaper +
   no `judge_cache.json`, but ambiguous-answer false-negatives possible.
   Per-level audit fixes any disclosed.
2. **5-tool surface, Medium scope** — `K_gaia.md §4`. SearXNG fallback
   chain mirrors Holosophus `academia_mcp/tools/web_search.py` (primary
   = self-hosted SearXNG, paid fallbacks Tavily/Brave); cheerio-only
   HTML extract (no `@mozilla/readability` dep); subprocess `python_exec`
   с 30s timeout + restricted env (PATH whitelist).
3. **Effective n=25 (5/30 tasks filtered)** — `K_gaia.md §7 Q5`. xlsx,
   pdf, pdb, jsonld, docx — image-attachments referenced on gated HF,
   not vendored.
4. **Single-shot, no user-sim** — unlike tau-bench. GAIA is QA over
   real-world facts, not dialog. `runGaiaTask` mirror'ит
   `tau-bench-retail/agent-runner.ts:78-210` shape без user alternation
   loop.

---

## Caveats for F-report

1. **n=25 single-seed**, K4 pending. Variance bars deferred.
2. **Web_search provider dependency** — measured accuracy depends on
   search quality. SearXNG free but quality varies; Tavily expensive
   but consistent. F-report должен disclose provider used.
3. **python_exec NOT Docker-sandboxed** — subprocess + 30s timeout +
   restricted env only. Acceptable для AHC research (trusted actor),
   but disclose в paper.
4. **Exact-match strictness** — 5-10% false-negative possible on
   ambiguous text answers (Holosophus convention).
5. **describe_image не exercised на real GAIA attachments** — gated HF
   attachments not vendored; tool tested на fixture PNG only.

---

## Reproduction

```bash
# Bake (idempotent)
pnpm tsx scripts/bake-gaia.ts
# → benchmarks/gaia/tasks/gaia_000.json ... gaia_029.json (25 files)

# K3 unit smoke (offline; mocked generateText)
pnpm exec vitest run src/eval/adapters/gaia-med.test.ts src/eval/adapters/gaia-tools/ src/eval/adapters/gaia-med/agent-runner.test.ts

# Spin up SearXNG infra (once)
docker compose -f observability/searxng-docker-compose.yml up -d
# Wait healthcheck (~15s), then sanity-curl
curl -s 'http://localhost:8080/search?q=test&format=json' | jq '.results | length'

# Probe webSearch directly (sanity без agent loop)
WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/check-gaia-search.ts 'invasive fish species USGS'

# K3 live pipeline smoke (requires OPENROUTER_API_KEY in .env)
set -a && . ./.env && set +a
WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml \
  --max-tasks-per-cell=5 --concurrency=1
# Expected: acc≈0.80 on n=5, total cost ~$0.19

# K4 main sweep (n=25 × 2 baselines, ~$5-10)
WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_gaia.yaml --concurrency=4
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_gaia/
```

---

## Tag

`git tag k-gaia-scaffold` after K1–K3 commit. `k-gaia-seed42` after K4
main sweep complete.
