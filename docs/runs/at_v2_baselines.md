# AT-v2 baselines (Track J6 — placeholder)

Snapshot of per-baseline numbers on the AT-v2 corpus (50 tool-grounded tasks).
Replaces the `assistant-traj` rows in `baselines_frozen.md` once the J6
follow-up sweep lands.

**Status: PENDING.** This file is a stub — real numbers populate after:

1. AT-v2 corpus drafts hand-extended to 5–15 turns per task (J3+J4
   `<draft>` markers → manual review + signoff).
2. Tool fixture files filled with real outputs via
   `scripts/capture-at-fixture.ts` (J2/J4 stretch helper; requires
   `AT_TOOL_MODE=live` + API keys: `OPENAI_API_KEY`, `BRAVE_API_KEY`).
3. Smoke run: `pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml --task-limit 1 --bench assistant-traj` — exit 0, RunRecord with `score.primary` non-null per baseline.
4. Full E1 re-run on AT-v2 (single seed=42, budget ≤ $5).

## Sweep config

- Sweep YAML: `eval/sweeps/main_e1_text.yaml` (no row-level change — adapter
  picks up n=50 automatically from `tasks/` dir).
- Bench: `assistant-traj`
- Seed: 42
- Budget: ≤ $5 (smoke + full E1 combined; AT-v2 is heavier than v1 only by
  tool replay overhead, which is in-process → no extra $ vs v1).

## Pending numbers table

| bench | baseline | n | input_tok | cache% | acc (primary) | tool_coherence pass% | total_$ |
|---|---|---|---|---|---|---|---|
| assistant-traj-v2 | full_context | 50 | — | — | — | — | — |
| assistant-traj-v2 | anthropic_compact | 50 | — | — | — | — | — |
| assistant-traj-v2 | mastra_om | 50 | — | — | — | — | — |
| assistant-traj-v2 | mastra-agent | 50 | — | — | — | — | — |
| assistant-traj-v2 | ahc_core | 50 | — | — | — | — | — |

## Expected qualitative diff vs AT-v1

(Hypothesis — verify against numbers once sweep lands.)

- `full_context` baseline `primary` should drop materially vs AT-v1 once
  hard-gate aggregation activates: any task where the agent skipped a
  required tool yields 0, even if the text answer is content-relevant. AT-v1
  had `tools_available=[]` for all tasks so this axis was invisible.
- `mastra-agent` baseline should outperform `mastra_om` on AT-v2 because
  it's the only tools-aware baseline. Magnitude depends on Mastra's tool
  dispatch wiring (the `mastra_agent.ts` baseline currently does **not**
  forward `opts.tools` into `agent.generate({tools})` — Mastra-side
  translator is deferred to a follow-up after Track J6 per
  `docs/investigations/mastra-tools-api.md`). Until that wiring lands,
  `mastra-agent` on AT-v2 will look identical to `mastra_om` (no tool
  calls observed).
- `ahc_core` (AHC active) should show smaller `primary` drop than
  `full_context` if the AHC value proposition holds — compaction preserves
  the context needed to decide on tool calls. This is the headline
  metric for F-report Discussion.

## Aggregation choice (J doc Q1)

J5 ships with **hard-gate aggregation**: `final.primary = content × (tool_coherence.pass ? 1 : 0)`.
If first AT-v2 sweep shows `full_context` losing > 30% signal versus AT-v1
because of the hard-gate, switch to proportional
(`final = content × required_called / required_total`). Decision recorded in
`docs/decisions.md` post-sweep.
