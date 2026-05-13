# tau-bench retail

Per `docs/design/D_assistant-traj.md §9` — agentic-state axis bench. Live tool
loop + user-simulator + state machine. Compaction tested DURING agentic
execution (between actor steps), not as pre-process — see Step 5 plan для AI
SDK `wrapLanguageModel({middleware: createAhcMiddleware})` integration.

## Layout

```
benchmarks/tau-bench/
  tasks/tau_retail_<NNNN>.json      # baked episodes (10 from upstream subset_ids @ seed=42)
  data/{users,orders,products}.json  # env initial state (deep-cloned per episode)
  wiki.md                            # retail assistant system prompt
  subset_ids.json                    # mirrored from upstream
  README.md
```

## Bake (one-shot)

The tau-bench retail env data + tasks aren't redistributable. User installs
upstream package + runs bake:

```sh
# 1. Install tau-bench (one-time):
pip install tau-bench   # OR: pip install git+https://github.com/sierra-research/tau-bench
# 2. Find package location:
pip show tau_bench | grep Location
#   → e.g. /usr/local/lib/python3.11/site-packages
# 3. Run bake:
pnpm tsx scripts/bake-tau-bench.ts /usr/local/lib/python3.11/site-packages/tau_bench/envs/retail
```

Bake copies:
- `data/{users,orders,products}.json` → `benchmarks/tau-bench/data/`
- `wiki.md` → `benchmarks/tau-bench/wiki.md`
- `tasks.json` × filter `references/mle-harness/results/taubench_episode_ids.json`
  (10 task_idxs) → individual `tau_retail_<NNNN>.json`

After bake — commit the generated files (MIT license).

**Note on expected_end_state:** real value requires replaying upstream
`actions` through env to derive terminal state — non-trivial. D5 bake writes
`{}` (= pass-by-default reward). E1 follow-up can compute real expected state
if reward differentiation matters там. Per D5 plan Risk #2 acceptable.

## Smoke fixtures

Two hand-built episodes:
- `tau_smoke_001.json` — cancel pending order (Alice's keyboard).
- `tau_smoke_002.json` — return delivered order (Bob's mouse).

Both have full `expected_end_state` so `calculateReward` non-trivially
discriminates pass / fail. Used for unit-style smoke runs.

`data/{users,orders,products}.json` — committed minimal env state covering
both smoke episodes. После real bake — upstream env data overwrites this.
