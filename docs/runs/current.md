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
- **lme-multiturn n=15+ rerun на AHC после parse-fix.** Observer
  parse-failure из 2026-05-26 закрыт 2026-05-27 (см. `decisions.md
  [2026-05-27]`) — parser теперь принимает ISO `YYYY-MM-DD` / slash
  `YYYY/MM/DD` timestamps, prompt получил anti-answer-leak правило +
  literal example output, в `records.ndjson` добавлено diagnostic поле
  `observerRawText`. Verified на n=3 debug sweep (12/12 non-empty fires,
  mean score 0.000 → 0.667, killer task `01493427` answers "25" correctly).
  Frozen n=15 row в `baselines_frozen.md` (`ahc_full_obs128k` 0.333) —
  pre-fix lower bound, ещё не пере-прогон. Full n=15 rerun (~$30) +
  возможно n=50 (~$60-100) — отложены до явного go из бюджета. Tracked
  but not blocking F-report — n=3 directional evidence пригоден для
  preliminary discussion.

Closed:
- **Observer prompt parse-failure (2026-05-26 → 2026-05-27)** — root
  cause: Gemini-3.1-Flash натурально пишет ISO/slash date'ы в timestamp
  поле, strict regex ждал integer epoch; killer task видел user-query и
  отвечал на него вместо extraction'а. Fix shipped в commit-after-this;
  `decisions.md [2026-05-27]` несёт полный narrative + n=3 verification.

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

**Closed (К-tail-4).** K1-K4 + четыре K-tail итерации завершены. Headline:
**Anthropic /compact sonnet-4.6 acc=0.60** взял highest acc, но AHC v3
(K-tail-3) **acc=0.44 при $0.93 cost** даёт лучший **cost-per-correct**
($0.084 vs sonnet $1.054 — AHC 12× efficient per success). Numbers +
provenance в `baselines_frozen.md` gaia-med section. Decision rationale —
`decisions.md` 2026-05-27 entries для K-tail-3 + K-tail-4.

K-tail итерации:
- **К-tail-1**: Mastra Memory integration — defaults 30K/40K observer/reflector
  fire слишком aggressive на multi-tool GAIA tasks. Mastra acc 0.28 / cap-hits 4/25.
- **К-tail-2**: Mastra thresholds 30K→100K, AHC thresholds 100K/200K. Mastra
  0.28 → 0.40; AHC 0.20 (recall path architecturally dead — 0 invocations
  across 25 tasks, prompt не упоминал pointers, execute path missing, digest
  lossy).
- **К-tail-3**: AHC recall-protocol fix — centralized prompt injection +
  two-stage rehydration (summary/full) + content-aware per-tool digest +
  execute path в `gaiaTools()` factory. Plus три side fix'а из debug pass
  (parallel tool calls в offloader, dedupe recall schema injection,
  `visit_webpage` Content-Type whitelist). Tightened thresholds 64K/100K.
  AHC 0.20 → **0.44**, +5 tasks на L2 (multi-tool reasoning).
- **К-tail-4**: Anthropic /compact + tools на GAIA-med как 4-й baseline.
  Native Anthropic SDK (AI SDK обойдён — beta knobs не пробрасываются).
  Тот же `GAIA_DRIVER_SYSTEM` + `gaiaTools()`. **Sonnet 4.6 acc=0.60 @
  $15.82** — headline accuracy на bench'е (единственный baseline разломавший
  L3 ceiling, 1/4). **Haiku 4.5 не поддерживает `compact_20260112`**
  (Anthropic API 400, vendor ограничение Sonnet+/Opus only). **0 compaction
  fires на n=25** — vendor's default 100K threshold выше per-call context
  на multi-tool GAIA tasks (cumulative до 940K, но per-call не пересекает
  100K). Sonnet's acc — model strength, не /compact strategy. AHC v3
  ($0.93) сохраняет 12× cost-per-correct advantage над sonnet ($15.82).

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
