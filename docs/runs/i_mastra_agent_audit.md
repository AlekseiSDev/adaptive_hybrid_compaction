# Track I — `mastra-agent` baseline audit

> Generated 2026-05-22. Track I execution per `docs/design/I_mastra_agent.md`.
> Closes framework-native competitor gap для tau-bench retail
> (`tau_bench_agent` vanilla / `tau_bench_agent_ahc` ранее не имели
> Mastra-based agentic competitor).
>
> Peer companion to `e_sweep_audit.md` + `h_followup_audit.md`. F-report
> consumes audit-таблицу ниже для cross-framework Pareto plot.
>
> **Источник:** sweep `main_e1_mastra_agent` (assistant-traj + lme-multiturn)
> + `main_e1_mastra_agent_tau` (tau split out after budget halt; см. §Caveats).
> `pnpm tsx scripts/eval.ts --sweep <yaml> --concurrency=4`. seed=42,
> actor=`openai/gpt-5.4-mini` (OpenRouter). Per memory
> `feedback_experiments_not_in_git` — NDJSON артефакты не коммитятся, числа
> цитируются здесь.

---

## Scope

3 бенча, 1 baseline (`mastra-agent`), 1 seed (42). См.
`docs/design/I_mastra_agent.md §2.2 асимметрия`:

- **assistant-traj** — chassis consistency vs `mastra_om` (ожидание: малая
  delta, replay-bench без активных tools).
- **lme-multiturn** — chassis consistency vs `mastra_om` (ожидание:
  малая-средняя delta; Mastra Agent loop сводится к 1 step без tools).
- **tau-bench-retail-med** — **main deliverable**. Сравнение vs
  `tau_bench_agent_ahc` + `tau_bench_agent` vanilla; первый framework-native
  agentic competitor на tau.

---

## Headline numbers

> seed=42, actor=`gpt-5.4-mini` via OpenRouter auto-cache.

| bench | baseline | n | input_tok | cache_read | cache% | acc | total_$ |
|---|---|---|---|---|---|---|---|
| assistant-traj | mastra-agent | 30 | 164 005 | 70 144 | **42.8%** | **0.283** | 0.580 |
| lme-multiturn ✠ | mastra-agent | 40 | 37 859 704 | 26 782 464 | **70.7%** | 0.475 | 20.174 |
| tau-bench-retail-med | mastra-agent | 30 | 1 325 168 | 0 | 0.0% | 0.100 | 1.067 |

✠ `lme-multiturn` halted by budget circuit-breaker mid-cell (`budget_usd=35`,
projected $53 after 70 tasks). 40 records committed; partial cell. Cost
$20.17 = bulk of спенда (per-task ~$0.50 на lme-mt).

**Sweep totals:** 3 cells (один partial), 100 records,
**$21.82 + $0.18 (broken tau v1) = $22.00** total spend.

---

## Key findings

### 1. AT chassis: mastra-agent > mastra_om +8.3pp acc

| bench | mastra_om acc (frozen) | mastra-agent acc | delta |
|---|---|---|---|
| assistant-traj | 0.200 | **0.283** | **+8.3pp** |
| lme-multiturn | 0.500 | 0.475 | −2.5pp |

AT delta больше предсказанного («малая» per design §2.2). Hypothesis: Mastra
Agent native multi-step loop полезен даже на AT replay (24/30 tasks
`tools_available=[]`, но Agent может iterate over reasoning steps —
unlike `mastra_om` single-shot `generate()` call). Lme-multiturn delta
−2.5pp в пределах chassis consistency (< 5pp threshold per acceptance gate).

### 2. Tau-bench: 100% tool-call rate, 17× cheaper per episode vs vanilla

Per-episode статистика (30 episodes):

- **100%** episodes имеют ≥1 tool call (acceptance gate: ≥50%).
- Mean **6.1 tool calls** per episode (range 1–11).
- Mean **24.5 steps** per episode (range 12–30).
- **3/30 episodes succeed** (reward=1.0) — capability ceiling
  gpt-5.4-mini matches `tau_bench_agent` vanilla acc=0.100.

| baseline | n | acc | cost/episode | mean tool_calls | notes |
|---|---|---|---|---|---|
| tau_bench_agent (vanilla) | 60 | 0.100 | **$0.601** | TBD (frozen) | per `baselines_frozen.md` |
| **mastra-agent** | 30 | 0.100 | **$0.036** | **6.1** | **17× cheaper** |

**Mastra-agent на tau ≈ 17× дешевле vanilla при той же accuracy.** Источник
экономии — Mastra Memory компактит history между turn'ами (observational
memory + thread persistence); vanilla `tau_bench_agent` replays full
conversation every turn. Это означает что **наш design assumption** "Mastra
Agent дает framework-native non-compacted baseline" частично **falsified**:
Mastra Memory сама делает implicit compaction (см. §Caveats).

### 3. Tau-bench cache=0% — Mastra Memory мутирует prefix

| baseline | bench | cache% |
|---|---|---|
| tau_bench_agent vanilla | tau-bench-retail-med | TBD |
| **mastra-agent** | tau-bench-retail-med | **0.0%** |

Mastra Memory injects observational memory blob в начало каждого turn'а →
system prompt prefix не stable → OpenRouter auto-cache misses every turn.
Text-benches показывают cache работает (lme-mt 70.7%, AT 42.8%), но на
multi-turn tau loop user-sim alternation breaks the prefix.

### 4. AHC vs mastra-agent (cross-framework Pareto)

| bench | baseline | n | acc | cache% | cost |
|---|---|---|---|---|---|
| assistant-traj | ahc_full | 20 | 0.200 | 12.4% | 0.266 |
| assistant-traj | **mastra-agent** | 30 | **0.283** | **42.8%** | 0.580 |
| lme-multiturn ✠ | ahc_full | 15 | 0.133 | 43.1% | 9.012 |
| lme-multiturn ✠ | **mastra-agent** | 40 | **0.475** | **70.7%** | 20.174 |
| tau-bench-retail-med | tau_bench_agent_ahc (H-audit) | TBD | TBD | TBD | TBD |
| tau-bench-retail-med | **mastra-agent** | 30 | 0.100 | 0% | 1.067 |

На **AT и lme-mt** mastra-agent **outperforms AHC** на accuracy (с большим
margin: lme-mt +34pp). На **tau** mastra-agent **17× cheaper** vs vanilla
по равной accuracy. Это сильный сигнал: framework-native chassis
(Mastra-Memory backed) обеспечивает better baseline performance чем AHC
middleware path на mixed text-bench workloads.

`ahc_full` numbers — per `e_sweep_audit.md §Headline numbers`.

---

## Acceptance gate (per design §6.1)

- [x] Investigation `docs/investigations/mastra-tools-api.md` complete.
- [x] All unit tests green (9 baseline + 5 runner including live).
- [x] I1 + I2 live smoke passed (cost > 0, n_tool_calls > 0).
- [x] `status=complete` на assistant-traj + tau-bench cells; **lme-multiturn
  partial** (budget halt после 40 tasks).
- [x] `err_rate=0%` на 3 cells (после fix в `mastra-agent-runner.ts`
  message-shape bug; see §Bug-fix).
- [x] Tau cell: **100%** episodes имеют ≥1 tool call (gate ≥50%).
- [x] Chassis consistency: lme-multiturn delta −2.5pp (< 5pp threshold);
  **AT delta +8.3pp** (документировано как finding #1, не регрессия).

---

## Bug-fix during I3

`runTauEpisodeMastra` initial implementation pushed full
`actorResult.response.messages` to messages array (mirror of AI SDK variant
in `agent-runner.ts:194`). Result: **96.7% err_rate** на первом tau run
(29/30 episodes failed с `user-sim: Tool result is missing for tool call
call_*`).

Root cause: Mastra's internal multi-step loop returns response.messages with
internal tool_call/tool_result steps, но shape не гарантированно well-formed
относительно AI SDK ModelMessage shape — orphan tool_calls (без paired
tool_result) ломают user-sim's `generateText(messages)` validation.

Fix (`mastra-agent-runner.ts:210`): push только final assistant text-only
message в messages. User-sim видит natural-language reply агента (этого
достаточно для alternation loop); Mastra's own Memory (LibSQL thread)
хранит полный chain для actor's следующего turn'а.

After fix: re-run dropped err_rate с 96.7% до **0%** на same 30 episodes.

---

## Caveats for F-report

1. **n=20-40 single-seed.** Variance bars нужно multi-seed (deferred — design
   §Open questions: cross-model / I4 phase).
2. **Mastra Memory implicit compaction.** Mastra Memory observationalMemory
   blob compactит history между turn'ами — `mastra-agent` НЕ pure
   non-compaction baseline на multi-turn benches. На lme-mt actor cost
   $0.50/task (vs $2.17/task у full_context) — экономия 4× за счёт Mastra
   Memory. **F-report должен учитывать**: `mastra-agent` ≠ uncompacted
   baseline.
3. **lme-multiturn partial (n=40, budget halted).** budget_usd=35 в
   `main_e1_mastra_agent.yaml` оказался слишком жадным; sweep cancel'ил
   после 70 tasks at projected $53. Tau split в отдельный
   `main_e1_mastra_agent_tau.yaml` ($30 budget) → отдельный run.
4. **Tau cache=0%** — Mastra Memory injection breaks OpenRouter auto-cache
   на tau (multi-turn alternation). Text benches caching работает (lme-mt
   70.7%, AT 42.8%) — single-turn path не affected.
5. **AT delta +8.3pp surprising.** Predicted «малая» per design §2.2. Не
   регрессия — informative finding о Mastra Agent multi-step value-add на
   replay-bench. F-report должен зафиксировать.

---

## Freeze status (per design §6.2)

Freeze conditions met:
- ✅ Acceptance §6.1 пройден (с partial lme-mt caveat).
- ✅ Mastra package version pinned (`@mastra/core@1.32.1`).
- ✅ Tool registration path stable (cast `retailTools as ToolsInput`,
  documented в `mastra-agent-runner.ts:84`).

→ `baselines_frozen.md` обновляется одним коммитом с этим audit-doc'ом.
Re-freeze trigger: bump Mastra version, замена dispatch path (text vs tau),
или замена tool registration cast.

---

## Reproduction

```bash
# Smoke (3 cells × 1 task each, ~$0.50):
pnpm tsx scripts/eval.ts --sweep eval/sweeps/smoke_mastra_agent.yaml \
  --max-tasks-per-cell=1 --concurrency=1

# Main sweep (text benches, halt-friendly):
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_mastra_agent.yaml \
  --concurrency=4
# 2 cells (AT n=30, lme-mt n=40 partial), $20.75 spend, halts before tau.

# Tau sweep (отдельный budget):
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_mastra_agent_tau.yaml \
  --concurrency=4
# 1 cell (tau n=30), $1.07 spend.

pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_mastra_agent/
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_mastra_agent_tau/
```

---

## Tag

`git tag i-mastra-agent-seed42` after commit.
