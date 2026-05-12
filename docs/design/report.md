# Track F Design — Course Report

> Track-level design для финального курсового отчёта по NLP_Course_Template.
> Phase plan — `system_design §7.2 Track F`. Тонкий слой: section outline,
> figure plan, citation plan, reproducibility appendix structure, polish checklist.

---

## Meta

- **Track:** F (F1 structure → F2 figures + discussion → F3 polish)
- **Wall-clock:** 5 дней
- **Зависит от:** Track E (нужны все числа)
- **Артефакт:** PDF + source (markdown / latex по template)
- **Связь:** `system_design §2.3` (success criteria — что должно быть в Results),
  `system_design §6` (eval design — как описываем в Methods)

---

## 1. Scope

- **In**: section outline, figure list, citation plan, reproducibility appendix,
  final polish checklist.
- **Out**: исследовательские эксперименты (Track A–E), новые runs, новый код.

---

## 2. Section outline (по NLP_Course_Template)

| Section | Length | Источник содержания |
|---|---|---|
| 1. Introduction | ~0.5 page | `system_design §1.1, 1.2, 1.4`; framing problem + contribution |
| 2. Related Work | ~1 page | Mem0/Letta/Zep (cited from existing paper.pdf), LLMLingua, Mastra OM, native compact, codex#14589 |
| 3. Model Description | ~1.5 page | `ahc-algorithm.md` — 3-tier, classifier, observer, offloader. Includes block diagram (figure 1) |
| 4. Dataset | ~1 page | `system_design §6.2, 6.3` — 4 benches + AssistantTraj construction details |
| 5. Experiments / Setup | ~0.5 page | `system_design §6.1, 6.4, 6.5` — provider, metrics, baselines |
| 6. Results | ~2 pages | Main table + Pareto plots + per-class breakdown + ablation grid |
| 7. Discussion | ~1 page | Включая negative results если есть (`system_design §10`) |
| 8. Conclusion / Future Work | ~0.3 page | Что осталось post-MVP (см. `system_design §2.2`) |
| Appendix A: Reproducibility | ~0.5 page | Repo link, verify.sh, sweep definitions, model versions, seeds |

Target total: 8–10 pages по template.

---

## 3. Figure plan (F2)

| # | Figure | Source data | Type | Script |
|---|---|---|---|---|
| 1 | Block diagram AHC (3-tier + classifier + modules) | hand-drawn | Diagram | TikZ или Excalidraw export |
| 2 | Pareto plot per bench: accuracy × $/task | E1 results | Scatter, 4 subplots | `scripts/plots/pareto.py` |
| 3 | Per-class accuracy breakdown bar chart | B3 output | Grouped bar | `scripts/plots/per_class.py` |
| 4 | Ablation comparison: AHC variants × 2 benches | E2 results | Grouped bar | `scripts/plots/ablations.py` |
| 5 | Cache-hit rate comparison (optional) | E3 results | Bar | `scripts/plots/cache_hit.py` |

Tooling: matplotlib (Python) для plots; TikZ или imported SVG для diagram. Все scripts
читают NDJSON из `benchmarks/runs/`, выходят PNG + PDF (vector для финальной submission).

---

## 4. Citation plan

### 4.1 Из existing paper.pdf (cited, not re-run)

- Task-aware / Type-aware baseline numbers (existing paper).
- Mem0/Letta/Zep cross-session memory framing.
- LLMLingua-2 prompt compression.
- Existing harness implementation reference.

### 4.2 External

- Mastra OM — official docs reference.
- Anthropic `compact_20260112` — Anthropic docs / engineering blog.
- LongMemEval, LoCoMo, τ-bench, AppWorld — original papers.
- codex#14589 для tool_result drop measurement.

`refs.bib` keeps consistent format (BibTeX). Pre-final pass — `bibtex-tidy`.

---

## 5. Reproducibility appendix

```
A. Reproducibility

- Repository: <github-url>
- Verify: `./scripts/verify.sh` (PASS at submission tag)
- Sweeps:
  - Main: `eval/sweeps/main_e1.yaml`, ~$120 на OpenRouter, ~N hours wall-clock
  - Ablations: `eval/sweeps/ablation_e2.yaml`, ~$30
  - Cache hit: `eval/sweeps/cache_hit_e3.yaml`, ~$20 на Anthropic direct
- Models pinned:
  - Actor: google/gemini-3.1-flash (snapshot YYYY-MM-DD)
  - Judge: openai/gpt-5.4
  - Cache hit: anthropic/claude-sonnet-4-6
- Seeds: 42, 43
- Data:
  - LongMemEval, LoCoMo, τ-bench — public, instructions to obtain в repo README
  - AssistantTraj — released в `benchmarks/assistant_traj/`, anonymized; provenance documented
```

---

## 6. Discussion talking points (для F2)

Заранее, чтобы не забыть при написании:

- **Robustness across classes** — AHC vs single-policy на τ-bench (recovery from ~0).
- **Pareto доминирование** — per-bench breakdown, где AHC выигрывает, где нет.
- **Classifier accuracy** — если есть ground-truth class labels на калибровочных трассах,
  show classifier accuracy + impact on policy dispatch.
- **Per-class breakdown** — central artifact, объясняет почему AHC работает.
- **Reflection trigger frequency** — как часто срабатывал на medium-traj; cache cost.
- **Negative results** — если AHC проигрывает Mastra OM на text-only LongMemEval —
  framing как "cross-class robustness vs best-on-single-bench" (см. `system_design §9`).
- **Cost analysis** — $/task breakdown по где deny расходы (Observer LLM calls, recall
  invocations, etc.).

---

## 7. Final polish checklist (F3)

- [ ] Все figures referenced в text
- [ ] All numbers в таблицах consistent с NDJSON (spot check 5% manually)
- [ ] No "TODO" / "TBD" / placeholder в final text
- [ ] refs.bib проверен (нет broken cites, `bibtex-tidy` PASS)
- [ ] Терминология consistent (см. `ahc-algorithm.md §1` / `system_design §1.1`)
- [ ] Abstract фиксирует main contribution + headline numbers
- [ ] Code в repo open-able (README с quick start, license note)
- [ ] Negative results disclosed где applicable
- [ ] Page budget соблюдён (8–10 pages)

---

## Open questions

1. Submission format — PDF + source-link, или PDF only? Verify course requirements.
2. Page budget — strict 8 или есть buffer? Если strict — обрезать Related Work
   до 0.7 page (cite existing paper для Mem0/etc, не пересказывать).
3. Code release license — MIT или Apache-2.0? Default MIT (matches academic norms);
   verify if course requires other.
