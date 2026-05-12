# Multimodal arm (VisualWebArena) — SKIPPED, out of budget

## Why skipped
- Logged OpenRouter spend at decision time: **$59.44**.
- Mem0 unlogged ingest spend (its internal LLM calls bypass our cost
  wrapper): conservatively **$5–10** unaccounted.
- Tasks 1+2 of this delegation projected at **~$6.5** combined.
- Projected total at end of delegation: **$65 – $76 LOGGED**, with the
  Mem0 unknown overhead pushing the top end uncomfortably close to the
  hard $80 cap.
- VisualWebArena episodes at 12 episodes × 3 strategies × ~$0.5/ep
  ≈ **$18** of additional spend — would push us over the cap with
  certainty.

We chose budget safety over an additional benchmark arm.

## What this costs the paper
- The original RQ4 "ranking transfer to multimodal" cannot be answered
  with a multimodal benchmark in this iteration.
- The multimodal-arm Pareto figure becomes a "future work" note in the
  Limitations section.

## Recommended replacement framing for the writer
- Present the **cross-vendor sanity check** (`cross_vendor_summary.json`,
  Claude-Haiku-4.5 vs Gemini-3-Flash on the same 15 LongMemEval items)
  as the **ranking-transfer evidence** for RQ4, with the honest caveat
  that Spearman ρ between the two driver rankings is **−0.5** at n=15
  (so the headline ranking does NOT cleanly transfer across drivers
  at this small N — both drivers nevertheless show a clear
  cost-vs-accuracy tradeoff, but the optimal policy depends on the
  driver's robustness to short-context inputs).
- Move multimodal explicitly to **Limitations / Future work**: cite
  VisualWebArena and OSWorld-Multimodal as the natural targets, note
  that screenshot tokens per step (50–80k for VWA) make multimodal
  trajectories an even stronger compaction stress-test, and that the
  text-side findings are necessary-but-not-sufficient evidence for
  multimodal ranking.
