# LongMemEval-med

Per `docs/design/D_assistant-traj.md §9` — passive-recall axis bench. Single-turn
long-context QA over multi-session conversation history (~16k tokens). Compaction
quality measured as accuracy preservation under compaction.

## Layout

```
benchmarks/longmemeval/
  tasks/lme_<question_id>.json    # baked stratified subset (med = 120 items @ seed=42)
  subset_ids.json                  # frozen seed=42 selection (reproducibility anchor)
  judge_cache.json                 # LLM-judge cache (yes/no per question)
  README.md                        # this file
```

## Bake (one-shot)

The full upstream dataset (`longmemeval_s.json`) is **NOT committed** — it's hosted
by upstream (`github.com/xiaowu0162/LongMemEval`). Download once locally, then
run:

```sh
pnpm tsx scripts/bake-longmemeval.ts /path/to/longmemeval_s.json
```

This writes 120 individual task JSON files to `tasks/` + a frozen `subset_ids.json`.

After bake — commit the generated `tasks/*.json` + `subset_ids.json` to the repo
(MIT license allows redistribution; size ~MB total). `judge_cache.json` builds
incrementally as judge runs hit each task.

## Smoke fixtures

Three hand-built `lme_smoke_00{1,2,3}.json` fixtures pre-shipped for unit tests +
1-task smoke without requiring user to download upstream data. These cover:
- `single-session-user` (base judge template)
- `temporal-reasoning` (temporal template — off-by-one tolerance)
- `knowledge-update` (KU template — preference for updated answer)

The smoke fixtures stay в `tasks/` after bake too — they're isolated by their
`lme_smoke_*` prefix and don't collide with real upstream `question_id`s.
