# GAIA snapshot

Vendored read-only snapshot of GAIA (General AI Assistants benchmark)
data used by Track K (`docs/design/K_gaia.md`).

## Provenance

- **Source:** copied from neighbour project Holosophus
  (`/Users/Aleksei/Projects/ai_scientists/Holosophus/holosophos/
  evals_and_reports/data/gaia_validation_30.json`) on 2026-05-26.
- **Holosophus version:** matching git state of `/Holosophus/` at that
  date.
- **Upstream:** `gaia-benchmark/GAIA` on HuggingFace (gated dataset,
  `2023_all` config). Holosophus downloads via `huggingface_hub`; we
  use the local snapshot to avoid HF token + network dependency.

## Files

- `data/gaia_validation_30.json` — 30-task stratified subset of the
  GAIA validation split (165q total upstream). Levels: 1=8, 2=17, 3=5.
  Has-file: 5/30 (1 xlsx + 1 pdb + 1 jsonld + 1 png + 1 docx).

## Schema

Each item:
```
{
  "idx": int,            // 0-29
  "question": string,    // task prompt
  "answer": string,      // ground truth (exact-match grader)
  "level": "1" | "2" | "3",
  "has_file": bool,
  "file_path": string    // empty string if no file
}
```

## Attachments NOT vendored

The 5 `has_file: true` tasks reference files like
`2023/validation/<uuid>.xlsx` — these are on the gated HF dataset
repo, **not** copied here. Track K bake script
(`scripts/bake-gaia.ts`) filters them out per Medium-scope decision
(`docs/design/K_gaia.md §7 Q5`), giving effective n ≈ 25.

If future scope wants attachment tasks (K-tail) — fetch from HF via
`huggingface_hub` Python tool, store under `data/attachments/`, update
license note for redistribution.

## License

GAIA dataset license is **CC BY 4.0** (Mialon et al. 2023,
`arxiv.org/abs/2311.12983`). Attribution required when citing
results; redistribution of data permitted under CC BY terms. Note:
GAIA upstream is *gated* on HuggingFace (requires login + dataset
access request), but the license itself is CC BY — gating is a
distribution convention, not a license restriction.

Holosophus repository code is Apache 2.0; that license applies to
Holosophus code only, **not** to GAIA data passing through.

## Modification policy

Read-only. Do not edit. If upstream updates — re-copy whole file with
new snapshot date in this README. See
`references/README.md` for the vendoring policy.
