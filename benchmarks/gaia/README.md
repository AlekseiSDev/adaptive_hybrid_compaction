# GAIA-med — bench fixtures

Baked tasks for `gaia-med` bench (Track K). See:
- `docs/design/K_gaia.md` — design
- `docs/benchmarks.md §5` — справочник (после K4 audit)
- `references/gaia/README.md` — upstream snapshot provenance + license

## Files

- `tasks/gaia_<NNN>.json` × 25 — per-task records.
  Levels: 1=8, 2=12, 3=5 (after attachment filter).
  Schema: `{idx, question, answer, level, has_file, file_path}`.

## Rebake

```bash
pnpm tsx scripts/bake-gaia.ts
# defaults to references/gaia/data/gaia_validation_30.json
# Filters has_file:true (5/30 attachment tasks skipped — see K_gaia.md §7 Q5).
# Idempotent: re-running produces identical bytes.
```

## Grader

Pure exact-match with normalization (port of `get_gaia_metrics.py:88-127`).
No LLM-judge, no `judge_cache.json`. See `src/eval/adapters/gaia-med.ts`.
