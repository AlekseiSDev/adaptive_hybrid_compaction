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
> **Status (2026-05-26):** K1–K3 complete. K4 smoke validated **с
> live SearXNG**: 5-task smoke прошёл **acc=0.80** (4/5 correct) на
> ~$0.19. K4 main sweep (n=25 × 2 baselines) — ready to run; deferred
> только по бюджету. SearXNG infra committed: `observability/searxng-
> docker-compose.yml`. `web_search` default-strict (2026-05-26): chain
> требует `WEB_SEARCH_AUTOSELECT=true` opt-in (honest experiments).

---

## Scope

1 bench (`gaia-med`), n=25 effective (5/30 attachment tasks filtered at
bake — xlsx/pdf/pdb/jsonld/docx not vendored; Medium scope per design
§7 Q5). 2 baseline configs planned:

- `gaia_bench_agent` — vanilla agent (no AHC middleware)
- `gaia_bench_agent_ahc` — AHC-wrapped actor (full feature flags)

Seeds: 42. Budget cap: $50 (`main_e1_gaia.yaml`).

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

## Main sweep — READY (deferred only by budget)

После 2026-05-26 SearXNG commit (observability/searxng-docker-compose.yml)
+ probe + 5-task smoke pass — K4 main sweep полностью разблокирован.
Spend estimate: n=25 × 2 baselines × ~$0.04-0.10/task ≈ $5-10 (well
below `budget_usd: 50` cap в YAML).

**Run command:**
```bash
docker compose -f observability/searxng-docker-compose.yml up -d
set -a && . ./.env && set +a
WEB_SEARCH_AUTOSELECT=true SEARXNG_URL=http://localhost:8080 \
  pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_gaia.yaml \
  --concurrency=4
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_gaia/
```

**TODO post-sweep:**
1. Re-aggregate per-level (1/2/3) acc breakdown.
2. Update `## Headline numbers` table с реальными цифрами для
   `gaia_bench_agent` + `gaia_bench_agent_ahc`.
3. Update `baselines_frozen.md` rows.
4. Add per-tool usage distribution (count tool_calls per tool name).

---

## Headline numbers (PENDING K4 main sweep)

> Placeholder table — fills when main sweep executes. Format mirrors
> `i_mastra_agent_audit.md §Headline numbers`.

| bench | baseline | n | input_tok | cache_read | cache% | acc | total_$ |
|---|---|---|---|---|---|---|---|
| gaia-med | gaia_bench_agent | — | — | — | — | — | — |
| gaia-med | gaia_bench_agent_ahc | — | — | — | — | — | — |

Per-level breakdown (level 1 / 2 / 3) — populated post-sweep via
`pnpm tsx scripts/per-class-report.ts` (extended to support `level` as
class key; current pattern uses `class_signal` but `Score.secondary.level`
is the GAIA-native split).

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
