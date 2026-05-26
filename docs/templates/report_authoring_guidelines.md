# Report Authoring Guidelines

> Operative rules for building `results/<YYYY-MM-DD_HHMM>/results.{md,tex,pdf}`.
> Source of these constraints: user feedback during 2026-05-14 report
> iterations. Apply by default; deviations require explicit user OK.

## Page budget

- **Hard cap: 12 pages.** PDF must build to ≤12 pages under the
  `NLP_Course_Template.tex` preamble (T1 fontenc, `[english]{babel}`,
  `apalike` bib, `article` class).
- Target word count: ~3000 words `.md`. (Empirically 2900–3100 words
  → 11 pages PDF including all 4 figures and reproducibility tables.)
- No explicit page limit in the course template, but reviewers prefer
  concise. Hit the budget through tight prose, not by dropping
  required sections.

## Section sizing — mini-paragraph rule

These sections must fit in a **single short paragraph each** (4-6
sentences max):

- §7.2 Cache stability claim (caveat block)
- §7.4 Honest limitations (5 numbered items inline, one sentence each)
- §7.5 Bench selection limitation
- §7.6 Engineering improvements identified
- §6.4 Where mechanism stays inactive (per bench, one short ¶ each)

These sections can be longer (but still compressed):

- §1 Introduction (3-4 short paragraphs)
- §2 Related Work (1 paragraph per category, fewer cites)
- §3 Model Description (one paragraph per module — tier layout, atomic
  groups, classifier, observer, offloader, recall, cache invariance,
  flags)
- §6.1 Multi-turn LongMemEval — the principal real-world measurement
  (table + 1-2 paragraphs)
- §6.2 Cache stability cross-provider (table + caveat ¶ + observations ¶)

## Abstract

- **Max ~150 words.** Single paragraph.
- Lead with the **three principal findings as numbered list inline**:
  1. Multi-turn cost reduction (real-world measurement)
  2. Cross-provider cache marker round-trip (with explicit "30-60pp
     delta on same protocol" framing — not absolute 97%)
  3. Architectural extension over Mastra OM (the closest prior)
- Mention bonus τ-bench result if room.
- End with repository URL.

## Framing rules

### Lead with achievements, not deficits

- **First numbered claim** in Abstract/Conclusion = **multi-turn cost
  reduction** (real-world measurement, mechanism actually fires).
- **Second claim** = cross-provider cache marker (structural-shape
  argument).
- Honest limitations and bench-selection gap go in §7 Discussion, not
  Abstract or Conclusion lead.

### Cache stability claim must include the caveat

- The 97 % / 98 % numbers are **partially protocol-internal** (2-call
  bench protocol + cross-task auto-cache window). Don't lead with the
  absolute number as if it's user-facing cost saving.
- **Defensible framing**: delta vs `full_context` on the same protocol
  (+60pp LME-Med, +30pp LoCoMo-Med) + cross-provider mechanism
  verification (49 % Sonnet, 23 % Gemini direct).

### Multi-turn accuracy drop is a *trade-off*, not a *failure*

- AHC 0.133 vs `full_context` 0.500 on `lme-multiturn` is a Pareto
  position, tunable via `OBSERVER_THRESHOLD`. Frame as choice, not bug.

### Honest about bench-selection gap

- 4 of 5 cells produced `compaction_events = 0` /
  `offload_events = 0`; only `lme-multiturn` fires Observer.
- State this explicitly in §7.5 (one paragraph) — the architectural
  claims rest heavier on one cell than ideal.
- Don't hide it; don't repeat it across multiple sections (one
  appearance in §7.5 + brief reference in Abstract is enough; do
  **not** make a "Most important honest finding" subsection in §8).

## Figures

- **4 figures total**, target. Drop figures that:
  - Show AHC in a bad-light absolute view without an explanatory
    structural reason
  - Have low information density (single bar chart that's already
    captured by a table)
  - Were OK in earlier drafts but lost relevance after reframing
- **Drop `fig2_at_pareto` (AssistantTraj accuracy × cost)** — weak
  graph showing AHC at high cost without compaction firing. Phase D
  AT row in the cache-rate table is enough.
- Keep: `fig1_pipeline` (architecture overview), `fig3_cross_bench_acc`
  (shows multi-turn drop — honest data, framed as trade-off),
  `fig4_ablation_grid` (Observer ablation effect), `fig5_cache_hit`
  (cross-provider cache rate, the main quant claim).

## References

- **~10 entries in refs.bib.** Drop everything not directly cited or
  not strictly necessary.
- **NEVER use `author = {Anonymous}`** — arXiv preprints always have
  named authors. If real authors unknown / fake-fabricated, **drop
  the citation entirely** rather than print "Anonymous". Reviewer
  will catch it immediately.
- **Walk through every citation** before final build. For each
  `\cite{X}` in the body, verify the `X` entry exists in refs.bib and
  has plausible real authors + arXiv ID / venue.
- Drop survey-citations that don't pull weight; one foundational ref
  per category is enough.
- Drop blog-only refs (`mem0_blog`, `emergence_blog`) unless they
  carry a result no peer-reviewed source does.

## Recommended 10 refs (baseline set for this project)

1. `mem0_2025` — cross-session memory representative
2. `memgpt_2023` — cross-session memory foundation
3. `mastra_om_2026` — closest prior single-policy compaction (cite
   heavily: §1, §2, §3, §7)
4. `lost_in_the_middle_2023` — context utilization argument
5. `longmemeval_2024` — bench
6. `locomo_2024` — bench
7. `taubench_2024` — bench
8. `anthropic_compact_2026` — baseline + motivation
9. `codex_14589_2025` — motivation for type-aware offload (79 %
   tool_result token share)
10. `holosophus_2026` — prior agent-generated work (cite for
    provenance + extending claims)

## Repository URL

Hardcode: `https://github.com/AlekseiSDev/adaptive_hybrid_compaction`.
Appears in Abstract closing line + Appendix A Repository line.

## Output workflow (filesystem)

- Output dir: `results/<YYYY-MM-DD_HHMM>/` (timestamp required, not
  just date — avoids collisions on same-day rebuilds).
- Files: `results.md`, `results.tex`, `results.pdf`, `refs.bib`,
  `figures/*.{png,pdf}`. **Entire `results/` tree is gitignored** —
  report output is a build artifact, not source-of-truth. Snapshots
  are kept locally for the author's history.
- Mirror to `report/main.{md,tex,pdf}` + `report/figures/` at end of
  build (live working dir; also gitignored).

## Build commands

```sh
cd results/<datetime>
pdflatex -interaction=nonstopmode results.tex
bibtex results
pdflatex -interaction=nonstopmode results.tex
pdflatex -interaction=nonstopmode results.tex
# clean intermediates
rm -f results.aux results.bbl results.blg results.log results.out
```

After clean build:

```sh
cp results/<datetime>/{results.md,results.tex,results.pdf} report/main.{md,tex,pdf}
rm -rf report/figures && cp -R results/<datetime>/figures report/figures
cp results/<datetime>/refs.bib report/refs.bib
```

## Pre-submission checklist

- [ ] Word count `.md` ≤ ~3300 words
- [ ] PDF page count ≤ 12
- [ ] No `Anonymous` authors in refs.bib
- [ ] All `\cite{X}` keys exist in refs.bib
- [ ] No "TODO" or "TBD" in body (only the end-sentinel HTML comment)
- [ ] Repository URL placeholder replaced with real URL
- [ ] LaTeX build: 0 warnings, 0 undefined references
- [ ] Figures count ≤ 4 (or explicit reason for each beyond)
- [ ] Honest-limitations section ≤ 5 items, one sentence each
- [ ] `./scripts/verify.sh` green

## Style notes

- No emojis.
- Comparison framings preferred: `Δ vs X on the same protocol` rather
  than `97 % absolute rate`.
- Tables: `booktabs` (`\toprule`, `\midrule`, `\bottomrule`); no
  vertical rules; small / footnotesize for cells with many columns.
- Code identifiers in `\texttt{}`.
- One paragraph break between subsections in compressed sections; no
  bullet lists where prose works.
