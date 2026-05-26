# Docs Index

Routing-карта проекта AHC. Используй её, чтобы найти **smallest authoritative document**
для текущего вопроса — не грузи всё подряд.

## Canonical docs

| Файл | Роль |
|---|---|
| [`../README.md`](../README.md) | Public framing — что за проект и зачем |
| [`../CLAUDE.md`](../CLAUDE.md) | Operative instructions для Claude Code: routing, pipeline, TDD, harness rules |
| [`system_design.md`](system_design.md) | Цели, scope, архитектура, eval-protocol, phase plan, принятые решения |
| [`ahc-algorithm.md`](ahc-algorithm.md) | Paper-style algorithm overview: Abstract + Methodology + прообразы + альтернативы. Reader-facing. |
| [`design/A_ahc-algorithm.md`](design/A_ahc-algorithm.md) | Полная спецификация ядра (Track A design): 3-tier shape, classifier, offloader, observer, инварианты, public types, phase plan. Operative. |
| [`decisions.md`](decisions.md) | Append-only лог архитектурных и design-решений |
| [`../references/`](../references/) | Vendored snapshot upstream paper'а + harness (Holosophus). Port source для B1, cite source для F4.1. Не правим. |
| [`../report/main.md`](../report/main.md) | Primary deliverable Track F — paper-grade markdown по NLP_Course_Template. F1a skeleton + E-independent sections committed; Results/Discussion/Abstract заполняются в F1b/F2/F3. |
| [`ai-native-practices.md`](ai-native-practices.md) | Историческая референция: на основе чего настраивался harness проекта. Активно не читаем — рабочий процесс зафиксирован в CLAUDE.md |
| [`agent-pitfalls.md`](agent-pitfalls.md) | Anti-pattern log (создаётся при первой повторной ошибке) |
| [`benchmarks.md`](benchmarks.md) | Подробная дока по 4 датасетам (AT / LME / LoCoMo / τ-bench): что покрывает, скоринг, system prompt, ground truth, образцы |
| [`runs/baselines_frozen.md`](runs/baselines_frozen.md) | Frozen competitor baseline numbers (full_context / anthropic_compact / mastra_om / mastra-agent / tau vanilla / GAIA all variants) + Cross-bench ablations + audit caveats. **Canonical numerical source-of-record для F-report.** |
| [`runs/current.md`](runs/current.md) | Living status per active track: что идёт сейчас, что отложено, retire-pointers на ушедшие audit docs (Phase D / H / I / K / lme-multiturn n=50). |

## Track-level design docs

Промежуточный слой между `system_design.md` (intent + phases) и plan-mode плана фазы
(`~/.claude/plans/*.md`, per-step). Один трек — один документ; не дробим под фазы.
Каждый трек имеет свой design doc для единообразного routing.

| Файл | Трек | Когда читать |
|---|---|---|
| [`design/A_ahc-algorithm.md`](design/A_ahc-algorithm.md) | A (core) | Перед любой фазой A1–A6 — 3-tier shape, classifier, offloader, observer, инварианты, public types |
| [`design/B_eval-harness.md`](design/B_eval-harness.md) | B (eval) | Перед B1–B3 — telemetry schema, run persistence, statistical pipeline, cost circuit-breaker |
| [`design/C_baselines.md`](design/C_baselines.md) | C (baselines) | Перед C1–C3 — common Baseline interface, Mastra OM / Anthropic native / full-context wrappers |
| [`design/D_assistant-traj.md`](design/D_assistant-traj.md) | D (AssistantTraj) | Перед D1–D4 — task JSON schema, source pipeline, judge rubric |
| [`design/E_main-runs.md`](design/E_main-runs.md) | E (sweeps) | Перед E1–E3 — orchestration, parallelization, replication, failure recovery |
| [`design/F_report.md`](design/F_report.md) | F (report) | Перед F1–F3 — section outline, figure plan, citation plan, reproducibility appendix |
| [`design/G_ui.md`](design/G_ui.md) | G (demo UI) | Перед G1–G3 — Next.js skeleton, AHC integration, telemetry sidebar |
| [`design/H_ablations_and_TODOs.md`](design/H_ablations_and_TODOs.md) | H (follow-up runs) | Перед H1–H6 — cross-model honesty, multi-seed, extended ablations, scale-up, analysis hooks |
| [`design/I_mastra_agent.md`](design/I_mastra_agent.md) | I (mastra-agent baseline) | Перед I1–I3 — full Mastra Agent baseline (tools + loop), tau-bench adapter, sweep + audit |
| [`design/K_gaia.md`](design/K_gaia.md) | K (gaia-med bench) | Перед K1–K4 — bench shape (n=30 stratified, levels 1-3), 5-tool surface (web_search/visit_webpage/text_editor/python_exec/describe_image), exact-match grader, agentic runner |

## Per-phase plan

План фазы живёт в **`/plan-mode`** (триггерит пользователь). Автосохраняется в
`~/.claude/plans/*.md`, виден между сессиями. Структура плана — `Phase map` соответствующего
`design/<track>.md` (Core / Контракты / TDD seed на каждый шаг).

`docs/implementation/` — каталог с **историческими** per-phase ledger'ами (A1, A2, A4)
из раннего периода проекта. Новые не создаём.

## Investigations (по необходимости)

Когда root-cause или подход неясны — заводим `investigations/<topic>.md` по
[`templates/investigation_template.md`](templates/investigation_template.md).

## Templates

- [`templates/track_design_template.md`](templates/track_design_template.md) — скаффолд track-level design doc (гибрид system_design framing + design детализации)
- [`templates/investigation_template.md`](templates/investigation_template.md) — root-cause analysis
- [`templates/NLP_Course_Template.pdf`](templates/NLP_Course_Template.pdf) + [`templates/NLP_Course_Template.tex`](templates/NLP_Course_Template.tex) — submission template для финального отчёта Track F; PDF — образец вёрстки, TeX — source для optional latex path
- [`templates/prev_paper/`](templates/prev_paper/) — prev work cheat-sheet: `result.md` (headline-findings summary прошлой папиры) + `paper.pdf` (копия `references/paper/paper.pdf`). Cite source для F4.1; **caveat** — fully agent-generated, без human review

## Reading paths

- **Внешний reviewer / куратор курса (вход «с улицы»):**
  [`../README.md`](../README.md) → [`ahc-algorithm.md`](ahc-algorithm.md) (paper-style overview) →
  [`../report/main.md`](../report/main.md) (Abstract → Discussion) →
  при желании глубже: [`design/A_ahc-algorithm.md §2.3 + §2.4`](design/A_ahc-algorithm.md) (pseudocode + public API) →
  код: [`../src/core/index.ts`](../src/core/index.ts) →
  [`../src/adapters/ai-sdk-v6.ts`](../src/adapters/ai-sdk-v6.ts).
- **Старт работы над фазой существующего трека:** `system_design §7.2` → relevant
  `design/<track>.md` → `decisions.md` → план из `/plan-mode` (триггерит пользователь).
- **Старт нового трека / долгой инициативы (без existing design doc):**
  `system_design §7` scope row → скаффолд `design/<X>.md` по
  [`track_design_template.md`](templates/track_design_template.md) → дальше как обычно.
- **Bug или непонятное поведение:** `investigations/<topic>.md` (создать) → решение →
  если закрыто guardrail'ом, обновить CLAUDE.md / agent-pitfalls.md.
- **Изменение архитектуры или scope:** обновить `system_design.md` или relevant
  `design/<track>.md` в той же ветке, что и код; добавить запись в `decisions.md`.

Принцип: не загружай больше документа, чем нужно. Расширяй по мере блокировки.
