# LoCoMo-med

Per `docs/design/D_assistant-traj.md §9` — passive-recall axis (dialog variant).
Single-turn QA over multi-session dialog (~17k tokens per conversation), evaluating
compaction quality on long-range references / temporal anchors.

## Layout

```
benchmarks/locomo/
  tasks/lo_<NNN>.json             # baked subset (25 items from upstream subset_ids @ seed=42)
  subset_ids.json                  # mirrored from upstream
  judge_cache.json                 # LLM-judge cache (yes/no per QA)
  README.md
```

## Bake (one-shot)

The LoCoMo dataset (`locomo10.json`) isn't redistributable in our repo. User
obtains it from upstream (`snap-research/locomo` GitHub release or HF dataset
`Percena/locomo-mc10`):

```sh
# 1. Download locomo10.json locally (one-time).
# 2. Run bake:
pnpm tsx scripts/bake-locomo.ts /path/to/locomo10.json
```

The bake script:
- Reads upstream `locomo10.json` (10 conversations с full session data).
- Reads `references/mle-harness/results/locomo_subset_ids.json` (25 selected
  QA items @ seed=42, stratified categories 1-4, excluding 5=adversarial).
- For each selected QA item: merge with its conversation → `lo_<NNN>.json`.
- Writes `benchmarks/locomo/subset_ids.json` (mirror).

After bake — commit the generated `tasks/*.json` к репо (CC BY-NC dataset
licence allows academic use + non-commercial sharing).

## Smoke fixtures

Three hand-built `lo_smoke_00{1,2,3}.json` fixtures pre-shipped covering
categories 1 (single-hop), 2 (multi-hop), 3 (temporal). Allows unit tests +
1-task smoke without bake.
