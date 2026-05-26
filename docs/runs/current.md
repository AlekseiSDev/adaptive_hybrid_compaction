# Current — что идёт сейчас / что отложено

Living status per active track. Сменяет 6 retired per-track audit docs
(retire-commit cites их по именам — `git log --diff-filter=D docs/runs/`).
Числа per-baseline — `baselines_frozen.md`. Архитектурные решения —
`decisions.md`. Дизайн — `system_design.md` / `design/<X>.md`.

Принцип: 1-2 параграфа + bulleted active items per track. Не дублируем design
doc. Закрытые треки получают 1 line "frozen at X" + ссылку.

---

## Track A — Core algorithm

**Closed.** Frozen at H Phase 9 fix (Tier-2 cross-turn persistence + adaptive
Tier-3 token budget, см. `decisions.md 2026-05-22`). Архитектура и контракты
в `design/A_ahc-algorithm.md`; никаких open code workstreams. Любые правки
core — через `/plan-mode` с обоснованием в `decisions.md`.

---

## Track B — Eval harness

**Active (mostly closed).** B6 landed 2026-05-26 — Langfuse session/trace/span
hierarchy + cost rollup через регистрацию pricing в Langfuse models API
(нашли что `openai/gpt-5.4-mini` отсутствовал в их built-in таблице, отсюда
cost=$0). Spans теперь: `eval.task` = root trace (per-sample), `eval.turn` =
per `baseline.step` / per agent round, AI SDK auto-spans (`ai.toolCall`)
nest'ятся натурально.

Active:
- **Langfuse pricing registration — recovery скрипт нужен.** После `docker
  compose down -v` registered models теряются. Today одноразовый Python
  snippet в чате; стоит зафиксировать как `scripts/langfuse-register-pricing.ts`
  (~30 строк) + entry в `observability/README.md` ("после wipe запусти").

---

## Track D + E — Sweeps & benches

**Headline numbers landed Phase D, follow-ups в Track H (см. ниже).**
Subsets baked (LongMemEval n=120 stratified, LoCoMo n=25, tau-bench n=10,
assistant-traj n=30 v1 → AT-v2 n=50 pending). Pre-Phase-D numbers — historical,
не цитируем (см. `decisions.md 2026-05-13 — Phase D fast-track main bench
numbers`).

Active follow-ups (бюджет ~$25-30 на всё, ~$90 осталось от $500 OpenRouter):

- **AT synthetic n=60 generation** — расширить assistant-traj corpus с 30 до
  60 через LLM-generated tasks для лучшего ablation signal (n=20/config сейчас
  слабо, на AT ablation grid выдал identical 0.25 для всех configs). ~$1 на
  генерацию. Блокируется Track J (нужно решить AT-v1→AT-v2 cutover).
- **seed=43 multi-seed replication** — пропустили из-за budget при Phase D /
  Phase H. F-report цитирует single-seed numbers с per-task SEM как honest
  disclosure. Если remaining budget позволит — приоритет на main_e1_text
  (4 baselines × 3 benches × seed=43, ~$10).
- **Mastra OM threshold audit** — `mastra_om` baseline даёт +5pp над FC на
  longmemeval-med (0.700 vs 0.650), но никогда не верифицировали что Memory
  observation actually fires на real LME inputs. Defaults: trigger
  `observation.messageTokens=30000`; некоторые LME tasks ~106K — должен
  fire, но не подтверждено. Investigate: dump Mastra storage db per task,
  count observation rows.
- **Mastra connect-timeout mitigation** — `mastra_om` (4.0%) и `mastra-agent`
  (7.5%) showed error rates от connect timeouts к OpenRouter в
  lme-multiturn n=50 run. full_context stable 0%. Retry policy для Mastra
  internal HTTP calls — нужно проверить и опционально wrap.

---

## Track F — Report

**Primary deliverable.** Cite `baselines_frozen.md` как canonical numerical
source-of-record. Single-seed honest disclosure обязательна (см. семья
"Single-seed alternative — теряем sanity replication" в `decisions.md
2026-05-13 — E0 Replication semantics`).

Активная работа в `report/main.md`; B5 / B6 / H Phase 9 фиксы должны
упоминаться в Results discussion. mastra-agent disclaimer ("not pure
non-compaction baseline due to Mastra Memory implicit compaction") — must
explicitly state в Methodology.

---

## Track H — Follow-up sweeps & ablations

**Mostly closed; ОДИН активный workstream выскочил.** H1-H6 завершены
(cross-model honesty, multi-seed framework, extended ablations, scale-up,
analysis hooks). H Phase 8/9 implementation fixes для observer/Tier-3 поведения
зафиксированы в `decisions.md 2026-05-22`.

Active:
- **Observer extraction quality на lme-multiturn (NEW workstream).** n=50
  audit показал что 30pp gap (AHC@128k acc=0.200 vs full_context=0.540)
  **не объясняется truncation** — extraction pipeline отбрасывает точные
  ответы. Confabulation example: task `01493427` (ground truth "25
  postcards") — full_context отвечает "25", AHC отвечает "17" (observer
  вытянул "17" из старшей session). Workstream: ревизия observer prompt
  + добавление per-bench evaluation extraction quality. Без этого AHC не
  competitive на passive-recall axis для F-report.
- **lme-multiturn n=50 rerun на AHC variants отложен** (~$60-100). После
  post-fix observer работы acc=0.200 на n=10 — нужен full n=50 + n=120 для
  honest comparison vs full_context 0.540. Tracked but not blocking F-report
  (можем cite n=10 post-fix как preliminary).

---

## Track I — `mastra-agent` baseline

**Closed.** Acceptance 6.1 пройден 2026-05-22. Numbers в `baselines_frozen.md`
(Text benches + Tau-bench retail sections). Disclaimer о implicit compaction
зафиксирован там же — F-report must cite.

Deferred (не active):
- **Multi-seed для mastra-agent** — single-seed (=42) на всех 3 benches.
  Если будет H multi-seed sweep — добавим row.
- **Mastra tool-dispatch wiring beyond scope** — Track I phase follow-up,
  ничего не блокирует.

---

## Track J — AssistantTraj v2 (tool-grounded n=50)

**Active.** J1-J5 завершены (schema patch + cross-field rule + tool runtime +
corpus port + grader tool-coherence + cache invariance test). AT-v1 30
task files retired (Track J3 `git rm`).

Active:
- **J6 sweep pending.** `eval/sweeps/main_e1_*.yaml` правка на n=50; smoke
  1 task per baseline; numbers лягут в `baselines_frozen.md` Text benches
  table с пометкой "AT-v2" (не отдельный doc). Budget ≤$5.
- **AT-v2 draft status remains.** Tasks jay-canvas-seeded (21) + synthetic
  top-up (29). Per-task `provenance.review_signoff` несёт `<draft>` markers
  pending manual hand-extension до 5-15 turns + real fixture capture через
  `scripts/capture-at-fixture.ts` (J2/J4 stretch, требует live API). До
  этого AT-v2 numbers — preliminary.

---

## Track K — `gaia-med` bench

**Closed (К-tail-2); ОДИН deferred sweep.** K1-K4 пройдены, К-tail (Mastra
Agent integration) выявил threshold issue: defaults 30K/40K observer/reflector
fire слишком aggressive на multi-tool GAIA tasks (60-95K context). Bumped к
100K/200K (К-tail-2) — Mastra acc 0.28→0.40. Numbers в `baselines_frozen.md`
gaia-med section с full provenance.

Deferred (не active):
- **К-tail-3 — полный AHC threshold-sweep.** AHC gaia_bench_agent_ahc
  underperforms vanilla (0.200 vs 0.320) потому что K-tail-2 поднял только
  observer/reflector, а type-aware offloader (T_SIZE=4096, T_CUM=24000,
  K_RECENT=6) всё ещё offload'ит web_search results 20-50K chars
  немедленно — actor теряет search context на следующем step. Ожидаемо
  T_SIZE→50K, T_CUM→200K, K_RECENT→20 поднимет acc к parity с vanilla.
  Budget ~$3-5. Blocking? Нет — vanilla numbers competitive, AHC variant
  не in headline. Если F-report хочет показать "AHC on agentic" — нужен.

Persistent caveat:
- **Mastra opaque to Langfuse.** `@mastra/core` не expose'ит
  `experimental_telemetry` option (по состоянию `@mastra/core@1.32.1`).
  Per-tool diagnostic возможен только через `Score.secondary.n_tool_calls`
  (К-tail instrumentation в `src/eval/adapters/gaia-med/mastra-agent-runner.ts`).
  Не активный workstream — известное upstream ограничение.

---

## Pointer references

- Числа per (bench × baseline) → `baselines_frozen.md`
- Архитектурные / design decisions → `decisions.md` (append-only)
- Track-level design specs → `design/<X>.md`
- Per-phase plans (active) → `~/.claude/plans/*.md` (триггерится `/plan-mode`)
- Historical audit docs (retired 2026-05-26) →
  `git log --diff-filter=D docs/runs/` для full content:
  - `at_v2_baselines.md` (Track J stub) — no numbers, J6 sweep landed straight
    в `baselines_frozen.md`
  - `e_phase_d_todos.md` — TODO list folded в этот документ
  - `e_sweep_audit.md` — Phase D headline (`decisions.md 2026-05-13`
    cites cell numbers as tag `e-phase-d-fast`)
  - `h_followup_audit.md` — cache rates + ablation deltas мигрировали в
    `baselines_frozen.md` Cross-bench ablations section
  - `i_mastra_agent_audit.md` — tau 17× cheaper + Mastra Memory disclaimer
    в `baselines_frozen.md` Tau-bench section
  - `k_gaia_audit.md` — К-tail narratives + per-level numbers в
    `baselines_frozen.md` gaia-med section
  - `main_e1_text_lme_mt_n50_audit.md` — observer fix narrative +
    confabulation example в `baselines_frozen.md` text benches caveats
