# Peer Review: Task-Aware and Type-Aware Context Compaction for LLM Agent Trajectories

**Venue style:** NeurIPS / ICML / ACL caliber (top ML venue).
**Reviewer:** Anonymous
**Note on tooling:** the structured `mcp__academia__review_pdf_paper` tool was sandboxed to `/workdir/` and could not access `paper.pdf`. The review below is constructed from a careful read of `paper/main.tex`, the supporting result JSONs (`longmemeval_main_summary.json`, `taubench_summary.json`, `locomo_summary.json`, `cross_vendor_summary.json`, `mem0_attempt_documentation.md`) and the librarian results, so the score appears below as a reviewer-assigned value rather than a tool-produced one.

---

## Summary

The paper studies **write-time trajectory compaction** for LLM agents and contributes two new policies on a unified six-class typed-segment schema (system / user / assistant_text / assistant_reasoning / tool_call / tool_result): **type-aware** (per-role retention rules with a user-overflow fallback) and **task-aware** (compactor is conditioned on the live user query and instructed to keep query-relevant content verbatim, with `[session-N, turn-T]` citation hints). It evaluates these two policies plus three baselines (full_context, naive_truncation, rolling_summary) on four benchmarks: LongMemEval-S (n=120 + n=50 replication, budget sweep), LoCoMo (n=25, 3 strategies), τ-bench retail (n=10/strategy, 3 strategies), and a cross-vendor probe (n=15, Gemini-3-Flash vs Claude Haiku 4.5). Headline finding: task-aware Pareto-dominates full_context on LongMemEval (0.73 vs 0.65 at ~1.8% input tokens) and replicates on LoCoMo (0.84 vs 0.44 rolling), but **fails completely on τ-bench retail** (pass@1 = 0.00). Cross-vendor: ranking inverts on Claude Haiku (Spearman ρ = −0.5, n=15). The paper frames the take-home as: compaction-policy choice depends on whether the trajectory is conversational or tool-step driven, and on the driver model.

---

## Strengths

1. **The negative result is the paper's most valuable contribution.** Most compaction papers report wins. This one ships a clean Pareto win on chat-memory and then immediately publishes a complete failure (pass@1 = 0.00) on a tool-using agent benchmark, with a mechanistic explanation (the compactor over-prunes historical `tool_result` segments because they look off-topic relative to the latest sub-step query). The accompanying step-count and tool-call-count diagnostics (19.1 of a 20 cap, 17.3 vs 6.5 tool calls) are exactly the kind of evidence reviewers want for a failure-mode claim. This is unusually honest for the area.

2. **Statistical protocol is appropriate for the sample sizes.** Bootstrap 95% CIs (10k resamples), paired permutation tests vs full_context (10k permutations), and reported p-values not just deltas. The seed-43 n=50 replication on LongMemEval at 0.86 (CI [0.76, 0.94]) is a real held-out check, not a re-seeded train/test split. Pinning compactor and judge across strategies isolates the policy axis cleanly.

3. **Cost accounting is a step forward for the memory-systems literature.** Most prior memory papers report token counts but not USD. The paper logs every LLM call (12,274 rows, $60.83 total), publishes the per-row log, and explicitly distinguishes driver-side cost (where the input-token win lives) from total-system cost (which includes the compactor's full-history read once per query). This is the right framing.

4. **Cross-vendor probe forces honesty.** Running the same 15 items under Gemini-3-Flash vs Claude Haiku 4.5 and showing the ranking inverts (ρ = −0.5) prevents the paper from over-claiming "task-aware is the best policy" — the authors instead claim "policy choice depends on the driver." Few papers in this area run cross-vendor at all.

5. **Six-class segment schema is genuinely novel as a typed compaction interface.** ACON splits trajectories two ways (history vs observation); Complexity Trap splits two ways (observation vs reasoning). Distinguishing assistant_text from assistant_reasoning, and tool_call from tool_result, is a fine-grained policy surface that future work can build on.

6. **Self-criticism in §6 (Limitations) is comprehensive.** The Mem0 reproduction was partial and the paper says so; the multimodal arm was skipped and is in Limitations; cross-vendor n=15 and τ-bench n=10 are both flagged. Few authors call out their own n this honestly.

---

## Weaknesses

1. **Numerical inconsistency in the headline claim.** The abstract states task-aware reaches 0.73 accuracy at "~$\sim\!4.6\%$ of the input cost" (line 53), while §1 contribution 3 (line 105) and §5.1 (line 358) both say "$\sim\!1.8\%$" (line 105) and "$\sim\!1.8\%$" (line 358). The actual ratio from `longmemeval_main_summary.json` is 1952 / 106394 = 1.834%. The 4.6% figure in the abstract appears to be an artifact and must be corrected — it directly affects the strength of the headline claim.

2. **The headline statistical significance is overstated by phrasing.** Table 1 reports p = 0.108 for task_aware vs full_context on n=120. The paper writes "the paired-permutation test against full_context does not reach significance (p=0.108, n=120) but the deltas are positive on five of the six question types" (lines 360–361). At α = 0.05, the +8-point gap is **not statistically significant** by the paper's own pre-registered test. The abstract sells this as "strictly Pareto-dominating" and the conclusion (§7) says "0.73 accuracy on LongMemEval, vs. \$0.042 for full context at 0.65" without re-acknowledging the significance gap. The seed-43 replication (0.86 vs 0.66 at n=50) is needed precisely because the n=120 gap fails to reach significance — the paper should state this dependency explicitly. **Recommendation:** soften "Pareto-dominates" in the abstract and §1 to "Pareto-dominates on point estimate (CI overlap; replication-supported)" and report the joint two-seed evidence.

3. **Total USD framing is internally contradictory and the paper does not own it cleanly.** Table 1 shows task_aware at \$0.0519/q vs full_context at \$0.0422/q — i.e., **task_aware is more expensive end-to-end at single-query workloads**. The paper acknowledges this in §5.1 and pushes the win to "agent loops where the compacted output is replayed many times." But the paper never (a) defines the amortization regime quantitatively (how many queries before task_aware becomes cheaper?), (b) provides an empirical number for that break-even point, or (c) acknowledges that the conversational benchmarks (LongMemEval, LoCoMo) are *one query per haystack* — i.e., precisely the regime where amortization does not happen. The §7 Conclusion's "\$0.0009 driver USD/query for 0.73 accuracy" line is technically true but elides the compactor cost entirely. Reviewers will see this as cherry-picking the metric.

4. **Type-aware is a strawman in its current form.** The paper reports the user-overflow fallback fires on **100% of LongMemEval items** (line 235, line 600). At that point the policy has degenerated into a chained-summary policy (rolling_summary on user content) that abandons the per-class verbatim design. The paper itself (line 602–604) acknowledges "we believe a re-tuned per-class budget on tool-heavy benchmarks can move it above rolling_summary, but we lack the data here." Given that contribution 1 advertises "two new compaction policies," shipping one that degenerates 100% of the time on the headline benchmark and is competitive but not winning on τ-bench is thin. **Suggestion:** either (a) re-tune the user-budget share so the fallback does not fire (an obvious experiment) and re-run, or (b) reframe the contribution as "task-aware (proposed) plus a typed-schema reference design."

5. **τ-bench n=10 is too small for a "fails completely" claim.** The pass@1 = 0.00 result has a Wilson 95% CI of [0.00, 0.28] (the paper reports [0.00, 0.2775]). At n=10 a true underlying pass-rate of 25% would still give 0/10 with non-trivial probability (~5.6%). The paper's mechanistic story is plausible, but the headline "fails completely" reading would be much more defensible at n=30–50/strategy. The paper acknowledges this in Limitations §6(4); it should also acknowledge it in the abstract and §1, where the failure-mode framing is currently absolute.

6. **Cross-vendor n=15 cannot support "the ranking inverts."** Spearman ρ = −0.5 over k=3 ranks is computed on 3 pairwise comparisons (3 sign agreements out of 3 pairs). With n=15 items and three strategies, the Haiku numbers (0.53 / 0.47 / 0.40) all sit inside each other's CIs ([0.27, 0.80] / [0.20, 0.73] / [0.13, 0.67]). The "inversion" is a point-estimate pattern, not a tested claim. The paper does say "we treat this as a signal" (line 555) but the headline framing in the abstract ("the ranking inverts on Claude Haiku 4.5") is stronger than the data supports. **Suggested reframe:** "the ranking is unstable across drivers at n=15 (Spearman ρ = −0.5)" and avoid the verb "inverts" without a hypothesis test.

7. **Novelty positioning vs LongLLMLingua is under-defended.** §2 paragraph "Prompt compression" (lines 156–162) positions task-aware as different from LongLLMLingua because LongLLMLingua is "a static retrieval question" and task-aware uses "the agent's current user turn." This is a real distinction but the paper does not produce a head-to-head comparison or an ablation that isolates the contribution of the role-typed schema vs the live-query conditioning. **Concretely:** what does pure live-query-conditioned compression buy without the typed schema? The 6-class schema and the live-query are conflated in S5; an ablation that runs S5 with `role` collapsed to {user, assistant} would isolate the schema contribution.

8. **The Mem0 markers in Figure 1 are softer than the figure suggests.** The from-paper / from-blog markers are placed at "approximate per-query USD proxies (driver-mismatch caveat applies)" (caption). Per `mem0_attempt_documentation.md`, the partial reproduction at iso-driver gave 0.667 (n=15) — clearly *below* task_aware's 0.733 on the same n. The paper cites the Mem0 paper's 0.93 (gpt-4o-mini) and the blog 0.93 numbers as Pareto markers. The honest Pareto position is: task_aware at 0.73 (Gemini-3-Flash) Pareto-dominates Mem0 at 0.667 (Gemini-3-Flash, n=15 partial), and Mem0 at 0.93 with a likely stronger driver is a separate point not directly comparable. The figure (and text on lines 326–330) blurs these. **Recommendation:** add the iso-driver Mem0 partial point as its own marker and label it explicitly as "n=15 partial."

9. **No power analysis or pre-registered effect-size threshold.** Given that the headline n=120 result fails to reject at α=0.05 and the τ-bench n=10 result has a CI of width 0.28, the paper would benefit from up-front statements about minimum-detectable effect sizes. As written, the reader has to back-derive these from the CIs.

10. **Greyscale readability and figure captions.** I cannot verify the figure-rendering directly here, but the paper's figures rely on color encodings ("orange," "green" in Fig. 5 caption — line 567) and overlay multiple strategies in Pareto plots (Fig. 1). Captions should explicitly call out marker shapes/line-styles in addition to colors so the figures degrade gracefully under printing.

11. **Template deviation.** The paper uses `agents4science_2025` (single-column NeurIPS-style) rather than the IEEE Access two-column format the venue typically expects. **This is a venue-format issue, not content** — flagging only.

12. **Judge-prompt deviation on LoCoMo is acknowledged but not analyzed.** §3.3 line 261–263 says "on LoCoMo we use the same model under a unified-judge prompt with reasonable-equivalence (a deviation from the LoCoMo per-type metric, documented)." This is a real methodological deviation that could plausibly inflate task_aware's edge on LoCoMo (which is exactly where the headline 0.84 vs 0.44 number comes from). A side-by-side mini-experiment running both judge prompts on a 10-item sample would close this gap.

---

## Major Requests

1. **Fix the abstract/§1 numerical inconsistency on input-cost ratio.** The abstract says "$\sim 4.6\%$" (line 53) where §1 and §5.1 say "$\sim 1.8\%$" (lines 105, 358). The data give 1.83%. Pick one and use it consistently. If 4.6% is a different ratio (perhaps total tokens including compactor read?), define it explicitly.

2. **Reframe the Pareto-dominance claim in light of p=0.108.** The current abstract verb "strictly Pareto-dominating" is too strong for a result that does not reject H0 at α=0.05 on the primary benchmark. Either (a) report joint two-seed evidence (Stouffer / Fisher combination across n=120 + n=50) and re-state significance once if it passes, or (b) soften to "Pareto-dominates on point estimate; replication-supported." The seed-43 n=50 result is genuinely strong (0.86 vs 0.66 with non-overlapping CIs) and the paper should foreground that more.

3. **Add the iso-driver Mem0 partial-reproduction marker (0.667 at n=15) to Figure 1, distinct from the from-paper / from-blog markers.** The current figure shows from-paper Mem0 markers as if they were a clean baseline. The honest comparison is the iso-driver partial point.

4. **Run a τ-bench top-up (n ≥ 30/strategy) for task_aware specifically**, or re-state the result as a "directional failure under power-limited n=10." A 0/10 result with CI [0, 0.28] is an existence claim, not a strong negative. If budget prevents a top-up, re-word the abstract from "fails completely" to "shows zero successes at n=10 (CI [0, 0.28]); a directional failure pending a larger replication."

5. **Provide a break-even-amortization analysis for the total-USD claim.** Specifically: in agent loops where the compacted output is replayed K times, what K makes task_aware cheaper than full_context end-to-end? This is an arithmetic exercise from the per-call numbers and would let the paper justify its driver-side framing rigorously instead of rhetorically. Present it as a one-liner equation in §5.1 and a sensitivity range in Figure 1's caption.

---

## Minor Requests

1. Abstract line 52: "$\sim\!106{,}000$ tokens" — verify against `mean_input_tokens = 106394` in `longmemeval_main_summary.json`. Use 106k consistently.

2. §3.4 line 267: the cost cap "$80" in §3.4 vs §4 line 277 "single \$80 cap" vs Appendix C "$60.83 total" — clarify whether the cap was a budget envelope or actual spend.

3. Table 1: the "$p$ vs. full" column for `rolling_summary` reports 0.118; `longmemeval_main_summary.json` has 0.1182. Round consistently to 3 decimals or report all to 4.

4. Figure 5 caption (line 562–567) explicitly references colors ("orange," "green"). Add line-style cues for greyscale readers.

5. Table 5 (cross-vendor) is missing a USD/q column. Add it for parity with Table 1 and Table 3.

6. §3.3 line 263 "we use the same model under a unified-judge prompt with reasonable-equivalence (a deviation from the LoCoMo per-type metric, documented)" — point the reader to where this is documented (e.g., a `locomo_judge_note.md` file is in the artifact).

7. §4.6 (Mem0) line 326: "$\sim 7$\,k retrieval tokens $\times 0.93$ accuracy" — the multiplication notation is awkward; rephrase as "$\sim$7k retrieval tokens at 0.93 accuracy."

8. §5.1 line 351 ("\textbf{0.73}") and Table 1 are presented as the headline; consider also bolding the 0.86 seed-43 number when it appears in §5.1's "Replication and budget sweep" paragraph (line 397) for visual parity.

9. §5.4 Table 4 ("USD/ep" 0.140 for task_aware) should also note that 0.107 of this is compactor cost — the breakdown is in `taubench_summary.json` and helps the reader see the same cost-decomposition lesson as the LongMemEval section.

10. Appendix B Table 6 (per-question-type) — the column header "$n_{\text{tot}}$" is confusing because the per-cell n is the per-type n, not the total. Either drop the column or rename.

11. Add citations to recent (2025–2026) survey work on context compaction in your literature review for completeness.

12. The phrase "honest cost-vs-accuracy comparison" appears in both abstract (line 64) and §1 (line 99). Vary the phrasing.

---

## Overall recommendation

**Borderline Accept** — confidence **3 / 5**.

The contribution is real: a clean typed-schema interface, a genuine Pareto win on chat-memory at the point estimate, an unusually honest negative result on τ-bench, and a cross-vendor probe that prevents over-claiming. The execution (cost logging, replication seed, permutation tests) is above average for this area. The main reasons it is not a clean accept: (a) the headline n=120 result does not reject at α=0.05 and the abstract over-claims with "strictly Pareto-dominating"; (b) the τ-bench failure-mode claim rests on n=10 with CI [0, 0.28]; (c) the cross-vendor inversion is a point-estimate pattern at n=15; (d) one of the two proposed policies (type-aware) degenerates 100% of the time on the primary benchmark; (e) abstract/body inconsistency on the input-cost ratio (4.6% vs 1.8%). All of these are addressable in a revision, none is fundamental.

If the headline framing is softened, the Mem0 iso-driver point is added, and a break-even amortization analysis is included, this is a clean Accept. If a τ-bench n≥30 top-up confirms the failure, the paper becomes a strong field-defining negative-result contribution.

---

## Suggested authors-response priorities

If the authors can address only three things in a rebuttal, the highest-leverage items are:

1. **Fix the 4.6% / 1.8% inconsistency and soften "strictly Pareto-dominating" to a phrasing consistent with p=0.108 + replication.** This is a 30-minute edit and moves the paper from "reviewers will catch this" to "internally consistent."

2. **Combined-evidence p-value on n=120 + n=50.** Run Fisher's combined test (or a stratified permutation test pooling the two seeds) on the task_aware vs full_context comparison. With n=170 and the seed-43 effect being large, the combined test is very likely to reject at α=0.05, which would convert the paper's primary claim from "directional" to "significant" without requiring new data.

3. **Add iso-driver Mem0 partial point to Figure 1** with clear "n=15 partial" labeling. This honesty move strengthens the paper's most prominent figure and pre-empts the reviewer concern about the from-paper markers being unfair.

Secondary (if budget allows): a τ-bench n=20 top-up on task_aware specifically would convert the failure claim from suggestive (CI [0, 0.28]) to confirmed (CI roughly [0, 0.17] if still 0/20).

---

## Ship-able with minor revisions? — Conditional yes.

The paper is conditionally ship-able **with minor revisions** rather than major. The required edits are: (1) fix the 4.6% / 1.8% number, (2) soften the "Pareto-dominates" / "ranking inverts" / "fails completely" verbs to match what n=120 (p=0.108), n=15 (CI overlap), and n=10 (CI [0, 0.28]) actually support, (3) add the Mem0 iso-driver marker to Figure 1, (4) add the break-even amortization arithmetic to §5.1, and (5) add the combined-seed p-value. None of these requires new experiments. With those edits the paper is a clean accept; without them the headline framing is overstated relative to its statistical evidence in a way that top-venue reviewers will reliably flag.
