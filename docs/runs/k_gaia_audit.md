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
> **Status (2026-05-26):** K1–K3 complete (verify.sh all green, 693 unit
> tests + cache-invariance). K4 main sweep **deferred** — blocked on
> `web_search` provider key (Tavily/Brave/SearXNG self-hosted). Smoke
> (`MOCK_WEB_SEARCH=true`) validates pipeline end-to-end.

---

## Scope

1 bench (`gaia-med`), n=25 effective (5/30 attachment tasks filtered at
bake — xlsx/pdf/pdb/jsonld/docx not vendored; Medium scope per design
§7 Q5). 2 baseline configs planned:

- `gaia_bench_agent` — vanilla agent (no AHC middleware)
- `gaia_bench_agent_ahc` — AHC-wrapped actor (full feature flags)

Seeds: 42. Budget cap: $50 (`main_e1_gaia.yaml`).

---

## Smoke validation (K3 acceptance)

> `MOCK_WEB_SEARCH=true pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml --max-tasks-per-cell=1 --concurrency=1`

| bench | baseline | n | acc | cost_$ | err_rate | notes |
|---|---|---|---|---|---|---|
| gaia-med | gaia_bench_agent | 1 | 0.0 | 0.0073 | 0% | pipeline validated; mock search returned fixture results (acc=0 expected) |

**Record details** (`benchmarks/runs/smoke_gaia/gaia-med/1dcd84ecc73b608c/42/`):
- task_id: `gaia_000` (level=2)
- totals: input=8 142, output=269
- score: `{primary: 0, secondary: {level: 2}, judge_cost_usd: 0}`
- final_response_text: `"hierarchical"` (incorrect — ground truth: `"egalitarian"`)
- errors: `[]` (no exception, normalization path executed cleanly)

**Pipeline checks passed:**
- ✓ `defaultAdapterRegistry.resolve('gaia-med')` returns
  `{adapter: gaiaAdapter, grader: gaiaGrader}`.
- ✓ `defaultRunnerRegistry.resolve({baseline: 'gaia_bench_agent'})`
  returns Runner via `resolveGaiaRunner`.
- ✓ AI SDK v6 `generateText` with `stopWhen: stepCountIs(20)` + 5 GAIA
  tools wired correctly.
- ✓ `costFromUsage` accounting on `gpt-5.4-mini` returned `$0.0073` for
  8 142+269 tokens (matches `OPENROUTER_PRICING`).
- ✓ `gaiaGrader.score` returned `{primary: 0, secondary: {level: 2}}`
  per pure-normalization path (no LLM judge invoked — per
  `decisions.md 2026-05-22`).
- ✓ status=complete, err_rate=0%.

---

## Main sweep — DEFERRED

`main_e1_gaia.yaml` requires one of these env vars set:
- `SEARXNG_URL` (self-hosted SearXNG instance — Holosophus pattern, free)
- `TAVILY_API_KEY` (~$20/mo plan)
- `BRAVE_API_KEY` (~$3/mo plan)

Without any of these, K2 `web_search` tool falls back to mock and
accuracy degrades to 0% across the board (mock fixtures don't contain
real GAIA answers).

**TODO** (user-action items, picked up next K4 attempt):
1. Provision one search provider (recommend SearXNG self-hosted — no
   API cost, mirrors Holosophus precedent). Spin up via
   `docker run -p 8080:8080 searxng/searxng` or use Holosophus's
   `docker-compose.yml`.
2. `set -a && . ./.env && set +a && SEARXNG_URL=http://localhost:8080 pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_gaia.yaml --concurrency=4`
3. Re-run `pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_gaia/`
4. Edit this audit's `## Headline numbers` section с реальными
   per-level acc + per-tool usage distribution + cache rate.
5. Update `baselines_frozen.md` с rows для `gaia-med × gaia_bench_agent`
   + `gaia-med × gaia_bench_agent_ahc`.

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

# K3 live pipeline smoke (requires OPENROUTER_API_KEY in .env)
set -a && . ./.env && set +a
MOCK_WEB_SEARCH=true pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_gaia.yaml \
  --max-tasks-per-cell=1 --concurrency=1

# K4 main sweep (BLOCKED — needs web_search provider)
SEARXNG_URL=http://localhost:8080 pnpm tsx scripts/eval.ts \
  --sweep eval/sweeps/main_e1_gaia.yaml --concurrency=4
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_gaia/
```

---

## Tag

`git tag k-gaia-scaffold` after K1–K3 commit. `k-gaia-seed42` after K4
main sweep complete.
