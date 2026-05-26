# Track F Design — Course Report

> Track-level design для финального курсового отчёта по NLP_Course_Template.
> Phase plan — `system_design §7.2 Track F`. Тонкий слой: section outline,
> figure plan, citation plan, reproducibility appendix structure, polish checklist.

---

## Meta

- **Track:** F (F1 structure → F2 figures + discussion → F3 polish)
- **Wall-clock:** 5 дней
- **Зависит от:** Track E (нужны все числа)
- **Блокирует:** — (terminal трек, deliverable отчёта)
- **Primary artifact:** `report/main.md` — paper-grade markdown, source of truth.
  Пользователь собирает submission PDF из неё вручную. **LaTeX optional**:
  `report/main.tex` по [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex)
  собираем если есть buffer времени, иначе пропускаем — md достаточен как deliverable
  трека, latex-вёрстку пользователь докатывает сам.
- **Связь:** `system_design §2.3` (success criteria — что должно быть в Results),
  `system_design §6` (eval design — как описываем в Methods)

---

## Sources & references

Перед F1 — открой эти артефакты, не реконструируй из памяти:

| Что | Путь | Назначение |
|---|---|---|
| Course submission template (PDF rendered) | [`../templates/NLP_Course_Template.pdf`](../templates/NLP_Course_Template.pdf) | Образец финального формата — section order, length, типография, табличный стиль |
| Course submission template (TeX source) | [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex) | Скелет для LaTeX-варианта (опциональный artifact); section headings и `\cite{}` style |
| Prev paper headline findings | [`../templates/prev_paper/result.md`](../templates/prev_paper/result.md) | Summary прошлой работы (task-aware + type-aware compaction): что заявлено, какие p-values, негативные результаты на τ-bench, caveats |
| Prev paper PDF | [`../templates/prev_paper/paper.pdf`](../templates/prev_paper/paper.pdf) — дублирует [`../../references/paper/paper.pdf`](../../references/paper/paper.pdf) | Cite source (§4.1 ниже). Канонический путь — `references/paper/` (vendored snapshot), `docs/templates/prev_paper/paper.pdf` оставлен как удобный pointer рядом с шаблонами |
| Prev paper full workdir | `~/Projects/ai_scientists/Holosophus/workdir/compaction_policies__20260508_0231/` (вне репо) | Полный prior run: `figures/local/fig{1..7}_*.pdf`, `mle/results/{pareto_data.json,per_type_table.md,pooled_permutation_test.json,peer_review.md}`, `paper/{main.tex,refs.bib}`. **CAVEAT:** fully agent-generated, **without human review** — числа и фигуры цитируем как "prior agent-generated result" с явной meta-disclosure, не как peer-reviewed baseline. Код референсный, но порт идёт через `references/mle-harness/` (vendored, vetted) — оригинал workdir'а не source of truth |

**Subset уже vendored** в `references/` (см. [`../../references/README.md`](../../references/README.md))
— paper + mle-harness/code+results. Все остальные artifact'ы прошлой работы (raw runs,
figures, intermediate results) живут в Holosophus workdir и читаются ad-hoc по нужде.

---

## Output Layout

Two co-existing locations:

- **Live working dir** `report/`: `main.md` + `main.tex` + `main.pdf` + `figures/`
  + `refs.bib`. Перезаписывается на каждом ребилде. Удобен как "predictable path
  to latest" — для линков в README/CLAUDE.md/CI, для quick preview.
- **Per-run snapshot** `results/<YYYY-MM-DD_HHMM>/`: `results.md` +
  `results.tex` + `results.pdf` + `refs.bib` + `figures/`. **Local-only,
  gitignored** — рерорт-output не source-of-truth для репо, а build
  artifact. История прогонов накапливается локально для автора. Time-
  suffix (HHMM, 24h local) обязателен — два ребилда в один день
  без него дают коллизию. Пример: `results/2026-05-14_1525/`.

Правила:
- `.tex` генерится одновременно с `.md` по структуре
  [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex)
  — `T1 fontenc`, `[english]{babel}`, `\bibliographystyle{apalike}`, `booktabs`
  для таблиц. Тот же контент, две выдачи; markdown — primary, LaTeX —
  submission-pack для course.
- Workflow per build: пишем сразу в `results/<date>_<time>/`, в конце
  зеркалим `cp results/<date>_<time>/{results.md,results.tex}
  report/main.{md,tex}` + `cp -R results/<date>_<time>/figures
  report/figures`.
- F1/F2/F3 phase plan (см. ниже) не меняется — Output Layout — это
  filesystem-договорённость, не дополнительный этап.

---

## Outcomes

> Что становится видимым артефактом и как это проверить (1-2 команды). Track-level —
> для demo / acceptance gate (для пользователя / защиты). Per-phase — exit signal
> для агента-реализатора, симметричный TDD seed на входе. F — writing/polish трек:
> verify — manual review checks + build commands, не tests.

### Track F (после F3)

**Доступно (primary):**
- `report/main.md` — submission-grade markdown, source of truth. Структура повторяет
  NLP_Course_Template секции (§2 ниже). Все таблицы — markdown с реальными числами,
  inline citations в формате `[author2024key]` resolved через `report/refs.bib`,
  figures как `![caption](figures/fig_N.png)`. Из этого артефакта пользователь
  собирает submission PDF вручную (или мы автоматизируем через LaTeX путь —
  optional, см. ниже).
- `report/figures/` — все figures (PNG + PDF vector), сгенерированные deterministically
  из NDJSON в `benchmarks/runs/` через `scripts/plots/*`.
- `report/refs.bib` — BibTeX, `bibtex-tidy` clean.
- Appendix A Reproducibility (§5 ниже) — repo link, verify command, sweep configs,
  pinned models, seeds. Внутри `main.md`, не отдельный файл.
- Submission tag в repo.

**Доступно (optional, LaTeX path):**
- `report/main.tex` — LaTeX source по [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex)
  (`\documentclass{article}` + `T2A` + `babel[english]`). Делается **если осталось время
  в F3 после md PASS**; иначе скипаем — пользователь сам собирает submission PDF из md.
- `report/main.pdf` — финальный 8–10 pages PDF (только если latex path выполнен).

**Demo:** открыть `report/main.md` в любом markdown viewer — это deliverable Track F.
Если есть latex path — также `report/main.pdf` через `cd report && latexmk -pdf main.tex`.
Figures regenerate: `pnpm tsx scripts/plots/<plot>.ts benchmarks/runs/<run-id>/` —
deterministically переотрисовывает из NDJSON.

**Acceptance gate (md path, mandatory):** §7 polish checklist 100% PASS на `report/main.md`
(no TODO/TBD, page-equivalent budget соблюдён ≈8–10 template pages, терминология
consistent с `A_ahc-algorithm §1`, все figures referenced, refs.bib clean); все
figures regenerate deterministically (no hand-edited values); submission tag pushed
в repo, `./scripts/verify.sh` зелёный на этом tag'е.

**Acceptance gate (latex path, optional):** `report/main.pdf` builds без
errors/warnings; вёрстка matches template; те же §7 checks. Если latex не сделан —
gap фиксируется в submission tag commit message, deliverable Track F всё равно
считается выполненным на md path.

### Per-phase

| Фаза | Artifact (что доступно после) | Verify (1-2 команды) |
|---|---|---|
| **F1** | `report/main.md` skeleton со всеми sections из §2 (mapping на NLP_Course_Template секции), placeholder'ами на figures из §3, source mapping каждой section на конкретный artifact из Track E (no "TBD"). Сравнительный rationale vs `templates/prev_paper/result.md` (что мы делаем нового / иного) — first draft в Introduction | Manual review: каждая section в §2 имеет источник в Контракты-колонке F1; `grep -i "TBD\|TODO" report/main.md` пусто |
| **F2** | Figures 1–5 из §3 сгенерированы в `report/figures/`; discussion sections (§6 talking points) заполнены реальными numbers из NDJSON | `pnpm tsx scripts/plots/pareto.ts benchmarks/runs/e1/` + аналогично для per_class/ablations/cache_hit — re-run даёт байт-идентичные PNG/PDF |
| **F3** | `report/main.md` submission-grade, §7 polish checklist отмечен, submission tag в repo. **Если есть buffer** — `report/main.tex` build'ится по [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex) | `bibtex-tidy --check report/refs.bib` PASS + manual walk-through §7 checklist (9/9 boxes ticked). Если latex path выполнен — `cd report && latexmk -pdf main.tex` без errors |

---

## Phase map

Pointer-маппинг «фаза → секции». Source of truth по фазам — `system_design §7.2 Track F`.
Колонки:

- **Depends / Blocks** — внутри- и кросс-трек зависимости; читается планировщиком для параллелизации сабагентов.
- **Core** — секции, без которых фазу не реализовать.
- **Контракты** — артефакты/входы из Track E (NDJSON, sweep configs, числа), на которые опирается фаза.
- **TDD seed** — отчётный трек не делает unit-тестов; вместо failing test — проверяемый exit criterion фазы.
- **Cross-cutting** — секции, которые могут потребоваться при правках на стыке.

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **F1** Структура отчёта по NLP_Course_Template | Track E (все числа — main sweep, ablations, cache-hit) | F2 | §1, §2 section outline, §4 citation plan, §5 reproducibility appendix | E1 main sweep NDJSON, E2 ablations, E3 cache-hit, `system_design §1, §2.3, §6` | source mapping: каждая section в §2 имеет конкретный artifact-источник, no "TBD" в skeleton | §4.1 cites из existing paper.pdf, §4.2 external refs |
| **F2** Figures + discussion | F1 (skeleton с placeholders на figures) | F3 | §3 figure plan, §6 discussion talking points | NDJSON из `benchmarks/runs/`, scripts из `scripts/plots/` | figures regenerate from NDJSON deterministically — никаких stale numbers, hand-edited values | §2 Results section (figures referenced), `system_design §9, §10` negative results framing |
| **F3** Финальный pass + полировка | F2 | — | §7 final polish checklist, §5 reproducibility appendix | refs.bib, submission tag в repo, verify.sh PASS | §7 polish checklist 100% PASS (включая bibtex-tidy, page budget, терминология consistency) | §1 терминология из `A_ahc-algorithm §1` / `system_design §1.1` |

**Parallelization:** трек sequential по природе (написать → отрисовать → отполировать); F1/F2/F3 не параллелятся между собой, параллелизация возможна только через дополнительных людей, не сабагентов. F не блокирует ничего (terminal трек, deliverable отчёта).

**Orthogonal / deferred:**
- §8 Open questions — не блокируют фазы; разрешаются при contact с course staff, фиксируются в `decisions.md`.
- §4.1 vs §4.2 split — операционная классификация, читаем один раз при F1.

**Как пользоваться.** Phase map — маршрутизатор контекста для plan-mode / агента-реализатора:
перед фазой читаем только Core + Контракты + TDD seed (всё остальное в design doc — фон,
открываем при необходимости через Cross-cutting). Depends/Blocks показывают где фазы
параллелятся сабагентами. Сам план шагов и прогресс — отдельные артефакты: план фазы
приходит из `/plan-mode` (триггерит пользователь), автосохраняется в `~/.claude/plans/*.md`;
прогресс трекается через TaskCreate. Pseudocode и контракты остаются в design doc как
source of truth.

---

## 1. Scope

- **In**: section outline, figure list, citation plan, reproducibility appendix,
  final polish checklist.
- **Out**: исследовательские эксперименты (Track A–E), новые runs, новый код.

---

## 2. Section outline (по NLP_Course_Template)

NLP_Course_Template секции (см. [`../templates/NLP_Course_Template.tex`](../templates/NLP_Course_Template.tex)):
`Abstract → Introduction (+Team) → Related Work → Model Description →
Dataset → Experiments (Metrics + Setup + Baselines subsections) → Results →
Conclusion → Bibliography`. Маппим наши секции 1-в-1, **Discussion** и
**Appendix A: Reproducibility** добавляем поверх template (template-format
позволяет дополнительные секции перед Conclusion и appendix через \appendix).

| Section | Template section | Length | Источник содержания |
|---|---|---|---|
| Abstract | `\begin{abstract}` | ~0.15 page | Main contribution + headline numbers (заполняется в F3 last) |
| 1. Introduction (+ Team subsection) | `\section{Introduction}` + `\subsection{Team}` | ~0.5 page | `system_design §1.1, 1.2, 1.4`; framing problem + contribution. Team subsection — обязательный по template, заполняется в F1 |
| 2. Related Work | `\section{Related Work}` | ~1 page | Mem0/Letta/Zep (cited from `references/paper/paper.pdf`), LLMLingua, Mastra OM, native compact, codex#14589. **Включить:** одна строка про prior agent-generated work (`references/paper/`) с provenance disclosure (см. §4.1) |
| 3. Model Description | `\section{Model Description}` | ~1.5 page | `A_ahc-algorithm.md` — 3-tier, classifier, observer, offloader. Includes block diagram (figure 1) |
| 4. Dataset | `\section{Dataset}` | ~1 page | `system_design §6.2, 6.3` — 4 benches + AssistantTraj construction details |
| 5. Experiments / Setup | `\section{Experiments}` + 3 subsections (Metrics / Experiment Setup / Baselines) | ~0.5 page | `system_design §6.1, 6.4, 6.5` — provider, metrics, baselines. Template требует трёх subsections — заполнять все три |
| 6. Results | (часть `Experiments` или отдельная `\section{Results}`) | ~2 pages | Main table + Pareto plots + per-class breakdown + ablation grid |
| 7. Discussion | extra `\section{Discussion}` перед Conclusion | ~1 page | Включая negative results если есть (`system_design §10`). Сравнение с prev paper claims (`templates/prev_paper/result.md`) — где совпадаем, где расходимся |
| 8. Conclusion / Future Work | `\section{Conclusion}` | ~0.3 page | Что осталось post-MVP (см. `system_design §2.2`) |
| Appendix A: Reproducibility | `\appendix` block | ~0.5 page | Repo link, verify.sh, sweep definitions, model versions, seeds |

Target total: 8–10 pages по template. Markdown source (`report/main.md`)
организован теми же section headings; LaTeX-вариант (если делается в F3) — mapping
один-в-один через `\section{}` headings.

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

Source files в `references/` (vendored snapshot):
- `references/paper/paper.pdf` — PDF для прямых cite'ов. Также доступен у пользователя
  как [`../templates/prev_paper/paper.pdf`](../templates/prev_paper/paper.pdf) — это
  байт-идентичная копия (md5 match), канонический путь всё-таки `references/paper/`.
- [`../templates/prev_paper/result.md`](../templates/prev_paper/result.md) — headline-findings
  summary прошлой работы (pipeline phases, headline-significant numbers, paper IDs cited,
  honest scope caveats). Это короткий cheat-sheet для F1 — что у prev paper заявлено,
  какие p-values, негативный результат на τ-bench (pass@1=0.00), break-even K ≈ 1.25.
  Используется как референс при формулировке "что мы делаем нового" в Introduction.
- `references/paper/refs.bib` — BibTeX seed для нашего `refs.bib`.
- `references/mle-harness/results/` — raw NDJSON, `per_type_table.md`, `pareto_data.json`,
  `peer_review.md` для верификации чисел при необходимости.

Что цитируем:
- Task-aware / Type-aware baseline numbers (existing paper).
- Mem0/Letta/Zep cross-session memory framing.
- LLMLingua-2 prompt compression.
- Existing harness implementation reference.

**Provenance caveat для F2/F3 discussion:** prev paper (`references/paper/`) — fully
agent-generated, peer-reviewed только внутренним LLM-judge ("Borderline Accept",
`peer_review.md`), **без human review**. При cite'ах не позиционируем как peer-reviewed
prior art — формулировка типа "prior agent-generated study (Holosophus, 2026)" с
краткой meta-disclosure в Related Work и Limitations. Числа берём из `references/`
(vendored, checksums in git) а не из ad-hoc workdir'а.

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
  - Actor: openai/gpt-5.4-mini (snapshot YYYY-MM-DD; selected for automatic prompt-caching on OpenRouter — see `decisions.md` 2026-05-13)
  - Secondary actor (cross-vendor sanity, opt-in): google/gemini-3-flash-preview
  - Judge: anthropic/claude-sonnet-4.6 via OpenRouter
  - Cache-hit subset (E3): anthropic/claude-sonnet-4-6 via Anthropic direct API
- Seeds: 42, 43
- Data:
  - LongMemEval, LoCoMo, τ-bench — public, instructions to obtain в repo README
  - AssistantTraj — released в `benchmarks/assistant_traj/`, synthetic-sourced; provenance documented
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

**Mandatory (md path):**
- [ ] Все figures referenced в text
- [ ] All numbers в таблицах consistent с NDJSON (spot check 5% manually)
- [ ] No "TODO" / "TBD" / placeholder в final text (`grep -i "TODO\|TBD" report/main.md` пусто)
- [ ] refs.bib проверен (нет broken cites, `bibtex-tidy` PASS)
- [ ] Терминология consistent (см. `A_ahc-algorithm.md §1` / `system_design §1.1`)
- [ ] Abstract фиксирует main contribution + headline numbers
- [ ] Code в repo open-able (README с quick start, license note)
- [ ] Negative results disclosed где applicable
- [ ] Prev paper provenance disclosed в Related Work + Limitations (см. §4.1 caveat)
- [ ] Page-equivalent budget соблюдён (≈8–10 pages по NLP_Course_Template typesetting)
- [ ] Все section headings 1-в-1 mapping на NLP_Course_Template (§2 таблица)

**Optional (latex path, если делается):**
- [ ] `latexmk -pdf main.tex` builds без errors/warnings
- [ ] PDF physical page budget 8–10 страниц
- [ ] Figure layout не разваливает strict page budget

---

## Open questions

1. Submission format — PDF + source-link, или PDF only? Verify course requirements.
   (Decision сейчас: md = primary deliverable Track F, PDF собирает пользователь
   из md или из optional latex path — финальный submission format на стороне пользователя.)
2. Page budget — strict 8 или есть buffer? Если strict — обрезать Related Work
   до 0.7 page (cite existing paper для Mem0/etc, не пересказывать).
3. Code release license — MIT или Apache-2.0? Default MIT (matches academic norms);
   verify if course requires other.
4. Дублирование `docs/templates/prev_paper/paper.pdf` ↔ `references/paper/paper.pdf` —
   удаляем один из путей или оставляем оба? Решение pending — оставить оба до F1,
   там видно нужно ли pointer рядом с шаблонами.
