# Adaptive Hybrid Compaction for Medium-Distance Agent Trajectories

**Author:** Aleksei Stepin
**Course:** NLP, 2026 spring
**Repository:** <!-- REPO_URL: fill in F3 (github URL or anonymised tarball) -->

<!--
SOURCE-MAPPING (for reviewers and future edits — strip in submission):
  §0 Abstract           ← F3 (after Results; headline numbers from E1/E2/E3)
  §1 Introduction       ← system_design §1.1, §1.2, §1.4; templates/prev_paper/result.md (compare)
  §2 Related Work       ← references/paper/refs.bib + design/F_report.md §4
  §3 Model Description  ← design/A_ahc-algorithm.md §1–§9
  §4 Dataset            ← system_design §6.2, §6.3; design/D_assistant-traj.md
  §5 Experiments        ← system_design §6.1, §6.4, §6.5; design/B_eval-harness.md
  §6 Results            ← F1b: benchmarks/runs/{main-sweep,ablations,cache-hit-subset}/summary.json
  §7 Discussion         ← F1b/F2: deltas + F_report.md §6 talking points
  §8 Conclusion         ← system_design §2.2 + F1b numbers
  §A Appendix           ← system_design §11; eval/sweeps/*.yaml
-->

## Abstract

<!--
ABSTRACT: fill in F3 last. Skeleton (target 150-200 words):
  1. One-line problem framing — context compaction on medium-distance (5–15 turns) agent trajectories.
  2. One-line contribution — Adaptive Hybrid Compaction (AHC): a cheap trajectory classifier routes
     between query-anchored extraction (task-aware) and atomic-group offloading (type-aware),
     packaged as AI SDK v6 middleware.
  3. 2–3 headline numbers from §6: Pareto domination on N/4 benches; τ-bench recovery from ~0
     to ≥ 0.5; cache-hit ≥ 60% on Anthropic direct subset; ablation grid confirms each component.
  4. One-line limitation — vendor-specific cache measurement; small AssistantTraj n; classifier
     calibrated on a small set of trajectories.
  Repository link belongs in this block per NLP_Course_Template.
-->

## 1. Introduction

LLM-based assistants increasingly run **agent loops with tool use**: a single user request
spans multiple model calls and tool calls before a final response. As such trajectories grow,
the context window inflates with tool inputs, tool outputs, and intermediate reasoning. On
**medium-distance trajectories — five to fifteen turns, on the order of 20–80 atomic steps**
— the working session is already long enough that naïve full-context replay is expensive,
yet short enough that approaches designed for cross-session memory are misaligned with the
problem.

Existing compaction strategies systematically fail in this regime for distinct reasons:

- **Cross-session memory systems** (Mem0 [@mem0_2025], Letta/MemGPT [@memgpt_2023],
  Zep [@zep_2025], A-Mem [@amem_2025], HippoRAG [@hipporag_2024]) optimize for retrieval
  across separate sessions and pay significant indexing overhead that is wasted on a single
  session of fifteen turns.
- **Prompt-level token compression** (LLMLingua [@llmlingua_2023], LongLLMLingua
  [@longllmlingua_2023]) operates below the structural level and disregards the
  `tool_use`/`tool_result` atomicity that agent frameworks enforce.
- **Native provider compaction** (Anthropic `compact_20260112`) drops tool outputs that
  collectively dominate session tokens: measurement in the open-source `codex#14589`
  thread reports tool results at roughly 79% of session tokens, of which 0% survive two
  successive compactions.
- **Rolling-window** keeps recency only and discards relevant facts from earlier turns.
- **Recent observation-policy work** (ACON [@acon_2025], the *Complexity Trap*
  [@complexity_trap_2025], Agent-Omit [@agent_omit_2026]) studies what to keep in
  long-horizon agent contexts but does not propose a routing mechanism between
  *what-to-extract* and *what-to-offload* policies.

We argue these failure modes are **policy-class-conditioned**, not policy-quality-conditioned:
a single compaction policy cannot serve a `conversational` long-term-memory task and a
`tool_heavy` agentic task simultaneously. Prior agent-generated work on the same dataset
suite confirms this intuition in one direction — task-aware compaction Pareto-dominates
full-context on LongMemEval but degrades to pass@1 ≈ 0 on τ-bench [Holosophus, 2026; see
§2 for provenance disclosure].

**Contribution.** This work introduces **Adaptive Hybrid Compaction (AHC)**, a middleware
that:

1. Classifies the current trajectory into `conversational | tool_heavy | mixed` using
   cheap rules-based features (no LLM call in the hot path);
2. Routes to query-anchored extraction (task-aware) or atomic-group offloading
   (type-aware) — or to a mixed policy with differentiated thresholds — per turn;
3. Preserves a cache-friendly 3-tier shape inspired by Mastra OM [@mastra_om_2026]:
   immutable prefix, append-only observation log, mutable recent K turns;
4. Exposes a `recall_tool_result(id)` tool so the agent itself can rehydrate offloaded
   outputs on demand.

AHC is implemented as AI SDK v6 middleware and evaluated on four compaction benchmarks
(LongMemEval-Medium, LoCoMo-Medium, τ-bench retail medium, and a new multimodal
AssistantTraj bench) against four baselines (full-context, Anthropic native compact,
Mastra Observational Memory, AHC) with an ablation grid isolating each module's effect.

### 1.1 Team

Solo project. **Aleksei Stepin** — full project: design, implementation, evaluation,
report.

## 2. Related Work

**Cross-session memory.** A family of systems treats long-term context as a separate
retrievable store. Mem0 [@mem0_2025] indexes user facts into a vector store with
deduplication. Letta/MemGPT [@memgpt_2023] models the context window as paged
operating-system memory with explicit swap. Zep [@zep_2025] builds a temporal knowledge
graph over conversational facts. A-Mem [@amem_2025], HippoRAG [@hipporag_2024], and
MemoryBank [@memorybank_2023] each propose variants of similarity-driven recall with
different schema and decay assumptions. These systems target the cross-session regime —
they amortize indexing cost over many independent sessions — and are not optimized for
the within-session compaction we study here. Surveys of the broader space include
[@memory_survey_2025] and [@rag_to_memory_2025].

**Within-session observation-based compaction.** Mastra Observational Memory
[@mastra_om_2026] is the closest existing system: it maintains a 3-tier shape with an
observation log that grows append-only, claiming a new state-of-the-art on LongMemEval.
AHC adopts the 3-tier shape verbatim but adds a *type-aware* offload path for tool
outputs and a trajectory classifier on top.

**Policy-class-aware work.** ACON [@acon_2025] introduces a two-class observation-vs-
reasoning split with separate policies. The *Complexity Trap* [@complexity_trap_2025]
reports the surprising result that simple observation masking matches LLM summarization
in long-horizon tasks. Agent-Omit [@agent_omit_2026] trains an RL policy to omit
observations and thoughts adaptively. AHC differs in that the routing is **trajectory-
class-conditioned at runtime, with no model fine-tuning**: thresholds are calibrated on a
small set of traces but the policy itself is rules-based and feature-driven.

**Prompt compression.** LLMLingua [@llmlingua_2023] and LongLLMLingua
[@longllmlingua_2023] compress prompt tokens via a small auxiliary model. RecurrentGPT
[@recurrentgpt_2023] iteratively summarizes context for very-long generation. These
operate at the token level and are orthogonal to AHC's structural compaction — they could
in principle be composed.

**Native provider compaction.** Anthropic's `compact_20260112` strategy applies
server-side compaction transparently [@anthropic_compact_2026]. As documented in the
open-source `codex#14589` thread [@codex_14589_2025], `tool_result` blocks constitute
roughly 79% of session tokens but zero survive two successive native compactions, which
motivates the type-aware offload mechanism in AHC.

**Context utilization.** *Lost in the Middle* [@lost_in_the_middle_2023] documents
degraded model attention to middle-of-context content, which informs our decision to keep
Tier-3 (mutable recent K turns) bounded and to keep the Tier-2 observation log
append-only with rough chronological order.

**Benchmarks.** We evaluate on four compaction benchmarks: LongMemEval
[@longmemeval_2024] for long-term conversational memory, LoCoMo [@locomo_2024] for
very-long-term temporal recall, τ-bench [@taubench_2024] for tool-agent-user interaction
in the retail domain, and a new in-house AssistantTraj benchmark (§4.3) for the
multimodal assistant setting. Other benchmarks considered but out of scope for this study
include AppWorld [@appworld_2024] (state-match-heavy agent evaluation), VisualWebArena
[@visualwebarena_2024] and OSWorld [@osworld_2024] (multimodal web/desktop agents).

**Provenance disclosure on prior agent-generated work.** A 14-page study titled
*Task-Aware and Type-Aware Context Compaction for LLM Agent Trajectories: A Cost-vs-
Accuracy Pareto Analysis* [@holosophus_2026] was produced by an autonomous AI scientist
("Holosophus") in 2026 and reports many of the directional findings that motivate AHC
(task-aware Pareto-dominance on LongMemEval at ~2% of input tokens; task-aware degrading
to pass@1 ≈ 0 on τ-bench retail; cost break-even at K ≈ 1.25 queries). That paper was
peer-reviewed only by an automated LLM judge — its `peer_review.md` artifact gives
"Borderline Accept (3/5)" — and was **not human-reviewed** before circulation. We cite
its directional claims here as motivating hypotheses, not as established prior art; all
quantitative claims in §6 come from our own runs against the same harness reimplemented
in TypeScript (see §5.2 and Appendix A).

## 3. Model Description

AHC is structured as a thin compaction layer that sits between the agent loop and the
model provider. Architecturally it is a TypeScript implementation of the AI SDK v6
`LanguageModelV2Middleware` interface; its design is framework-agnostic (the `core/`
module has no AI SDK dependency), and the SDK adapter is one of `adapters/*.ts`.

### 3.1 Three-tier data layout

Conversation history is logically partitioned into three tiers, sliced via pointers over
a single message journal:

```
[ Tier-1: const prefix         ]  ← immutable; cached prefix end
  - system prompt
  - tool definitions
  - first-N user messages (N = 1 default)

[ Tier-2: append-only log      ]  ← grows only by appending
  - observation entries (from Task-Aware Observer)
  - pointer placeholders (from Type-Aware Offloader)
  - trajectory class signal (updated each turn)

[ Tier-3: mutable recent       ]  ← rewritten each turn
  - last K turns verbatim (K = 6 default)
  - the incoming user message
  - in-flight tool_use / tool_result pairs
```

The cache breakpoint is placed at the end of Tier-1. Tier-2 grows only by appending,
which preserves the longest-prefix-match property used by Anthropic's prompt cache. Tier-3
is the only zone fully overwritten each turn — and is kept small. This 3-tier shape is
adopted from Mastra OM [@mastra_om_2026]; the contribution of AHC is in the **routing
between tier-2-targeted and tier-3-targeted policies**, not in the tier shape itself.

A formal cache-invariance contract (§3.8) is enforced as a unit test.

### 3.2 Atomic groups

A `tool_use` block is bound to its `tool_result` block by the provider-issued `tool_use_id`.
We define an **atomic group** as the triple

```
{
  group_id:        hash(tool_use_id ++ turn_index),
  tool_use:        <Message>,
  tool_result:     <Message>,
  reasoning_chunk: <optional immediate assistant text>,
}
```

Atomic groups are processed indivisibly during compaction: either the entire group
remains verbatim in Tier-3, or the entire group is offloaded with a pointer
substitution. A bare `tool_use` without a `tool_result` would crash the provider API.

### 3.3 Trajectory classifier

The classifier is rules-based, runs every turn with O(1) cost via incremental counters,
and emits one of `conversational | tool_heavy | mixed`.

Features (computed incrementally):

```
tool_call_density   = tool_uses_total / turns_total
avg_tool_result_size= mean bytes of tool_result blocks
recent_tool_density = tool_uses in last 3 turns / 3
user_turn_ratio     = user_msgs / total_msgs
multimodal_flag     = any image/file attachment in history
```

Classification rule (defaults; weights tunable via calibration):

```
conv_score = (1 - tool_call_density) · user_turn_ratio
tool_score = tool_call_density · 0.5 + recent_tool_density · 0.5

if  turns_total < 2:                            return mixed   (cold start)
if  conv_score > 0.6 and tool_score < 0.3:      return conversational
if  tool_score > 0.5:                           return tool_heavy
                                                return mixed
```

**Hysteresis.** A change `conversational → tool_heavy` requires two consecutive turns
with `tool_score > 0.5`; this prevents single-turn outliers from flipping the policy.

### 3.4 Task-Aware Observer (conversational path)

When Tier-3 exceeds `OBSERVER_THRESHOLD = 8000` tokens on a `conversational` or `mixed`
trajectory, the Observer extracts query-relevant facts via a single LLM call (cheap model
— Gemini-3-Flash in our runs). The Observer prompt is conditioned on (1) the recent
Tier-3 messages, (2) the current user query, and (3) the last 4K tokens of prior
observations to avoid duplicate emission.

Extracted observations are appended to Tier-2 with a confidence label (`high | med | low`)
and a source-turn reference. After extraction, Tier-3 is clipped to a tail of
approximately 20% of `OBSERVER_THRESHOLD` (≈1.5K tokens), **excluding any in-flight
atomic groups** — partially formed tool calls cannot be trimmed without breaking the
provider API.

### 3.5 Type-Aware Offloader (tool-heavy path)

The offloader operates on Tier-3 atomic groups on `tool_heavy` and `mixed` trajectories.
For each candidate group it computes

```
should_offload(group, ctx) =
   ctx.groups_after_this >= 2                     // always keep last 2 atomic groups
   AND ( bytes(tool_result) > T_SIZE              // 4 KB default
       OR  ctx.cumulative_kept_bytes + bytes > T_CUM )  // 24 KB cumulative
```

When triggered, the original `tool_result` is moved to an out-of-prompt **scratchpad**
keyed by `group_id`, and the in-prompt `tool_result` is replaced by a compact pointer
placeholder of the form

```
[Offloaded tool_result #G42 | tool=search_docs | size=8.2KB
 | digest: "Found 3 docs matching 'auth middleware'. Top: doc_237 (score 0.91)…"
 | recall_id=G42]
```

The digest is generated by one of three strategies, in order of preference: (1)
schema-aware projection if a tool JSON schema is registered (`SCHEMA_AWARE_DIGEST=true`);
(2) a single LLM call with a fixed 80-token summarization prompt; (3) a rule-based
head+tail truncation fallback.

### 3.6 Recall tool

Whenever the scratchpad is non-empty, AHC injects a stable tool definition into the
agent's tool list:

```
recall_tool_result(recall_id: string, reason: string) -> <full tool_result>
```

The tool definition is stable across turns (does not break cache prefix). Recall logs
are emitted as telemetry events for measuring `recall_usage_rate` per task. Crucially,
a recall does **not** rehydrate the full tool_result into Tier-2 or Tier-3 — it appears
only in the current step's `tool_response`. This preserves cache invariance.

### 3.7 Async buffer and reflection

Two further modules handle edge regimes.

The **async buffer** pre-emptively runs the Observer in the background whenever the
agent is idle (between turns) and Tier-3 has crossed 80% of the activation threshold.
This is inspired by Mastra OM activation hooks: `activateAfterIdle` (sync with Anthropic
prompt-cache TTL), `activateOnProviderChange`, and `blockAfter` (force-sync on 1.2 ×
threshold). On consumption the prepared compaction is applied near-instantly.

The **reflection layer** is a rare deep-recompression of the entire Tier-2 log when it
itself becomes large (default `REFLECTION_THRESHOLD = 40000` tokens). Reflection invokes
a more aggressive LLM, merges related observations, drops outdated ones, and rewrites
Tier-2. Reflection is **the only operation that observably breaks the cache-invariance
prefix**; it is logged and rare on medium-distance trajectories.

### 3.8 Cache invariance contract

For every turn `i`, the bytes of `(Tier-1 ++ Tier-2_stable)` produced by AHC at turn `i`
must be byte-identical to those at turn `i − 1`, where `Tier-2_stable` is the prefix of
Tier-2 up to the most recent reflection event. This invariant is enforced as a unit test
in `src/core/__tests__/cache-invariance.test.ts`. Reflection is the only operation that
intentionally breaks it.

### 3.9 Feature flags and ablation surface

Every module is gated behind a feature flag:

| Flag                     | Default | Disables                                                |
|--------------------------|---------|---------------------------------------------------------|
| `TASK_AWARE_EXTRACTION`  | true    | Task-Aware Observer (conversational path)               |
| `TYPE_AWARE_OFFLOAD`     | true    | Type-Aware Offloader + scratchpad (tool-heavy path)     |
| `TRAJECTORY_CLASSIFIER`  | true    | Adaptive routing; fallback to configured class          |
| `ASYNC_OBSERVER`         | true    | Async buffer (fallback to sync compaction)              |
| `RECALL_TOOL`            | true    | Injection of `recall_tool_result` tool                  |
| `SCHEMA_AWARE_DIGEST`    | false   | Schema projection (LLM-summarize fallback)              |
| `REFLECTION`             | true    | Deep Tier-2 recompression                                |
| `CALIBRATION_AUTO`       | false   | Threshold calibration from traces                       |

This surface drives the ablation grid in §5 and §6.

## 4. Dataset

We evaluate on four compaction benchmarks. Three are public benchmarks ported to a
TypeScript adapter; one is constructed for this work.

### 4.1 LongMemEval-Medium

LongMemEval [@longmemeval_2024] is a long-term conversational memory benchmark; we
select the **medium** subset (`haystack_sessions ≤ 3`) and sample `n = 60` tasks under
seed 42, with `n = 30` replication under seed 43. Selection is stratified across the
benchmark's question types (single-session-user, two-session, knowledge-update,
multi-session-temporal, multi-session-preference).

### 4.2 LoCoMo-Medium

LoCoMo [@locomo_2024] is a very-long-term conversational benchmark; we use a medium
restriction (first eight sessions per dialog) and `n = 20` tasks. Adapter follows the
upstream Python harness pattern.

### 4.3 τ-bench retail (medium)

τ-bench [@taubench_2024] is a tool-agent-user interaction benchmark; we restrict to the
retail domain and to tasks with optimal path length 5–15 actions (`n = 25`). This is our
primary tool-heavy benchmark.

### 4.4 AssistantTraj (new)

AssistantTraj is constructed for this work as a multimodal medium-distance assistant
benchmark. Tasks are sourced from three streams:

1. **Jay-canvas-seeded scenarios** — synthetic end-to-end fixtures from an internal
   2D-canvas project (no PII), hand-extended to medium-distance trajectories of 5–15
   turns by the author.
2. **Open-source assistant traces** — collected from public benchmark releases with
   compatible licenses where they fall in the medium-trajectory range.
3. **Synthetic top-up via Sonnet** — generated to reach the target size of 30–40 tasks,
   with 100% manual review of each task.

Tasks are balanced across four categories: image-grounded Q&A (~8), code generation
with file-read tools (~8), research-then-write (~8), and mixed assistant flows
(~6–16). Each task includes input messages, expected outputs, and an evaluation rubric.
Inexact answers are scored by an LLM judge (GPT-5.4) using category-specific rubrics; a
10% sample is human-verified to calibrate judge bias. Schema and provenance for each
task are committed in `benchmarks/assistant_traj/`.

### 4.5 Why these four benchmarks

The four benchmarks isolate distinct compaction failure modes. LongMemEval and LoCoMo
test the **passive-recall axis**: a long history must be compacted so that single-turn
QA still succeeds. τ-bench retail tests the **agentic-state axis**: a live tool loop
where compaction between steps must preserve enough state for the next action.
AssistantTraj tests the **trajectory-coherence axis**: multi-step assistant flows with
multimodal content and follow-up references. AHC's claim of cross-class robustness can
be falsified on any of the four axes.

## 5. Experiments

### 5.1 Metrics

We report six metrics per `(bench, baseline, seed)` cell:

- **Accuracy** — bench-specific: exact-match for LongMemEval and the closed-form parts
  of AssistantTraj; LLM-judge (GPT-5.4) score with a fixed rubric for free-form
  responses; pass@1 for τ-bench tasks.
- **Tokens per turn** — input + output, mean and p95, averaged over the trajectory.
- **Prompt cache-hit rate** — `cache_read_input_tokens / total_input_tokens` per turn,
  averaged. Reported only on the cache-hit subset (Anthropic direct API, Sonnet-4.6),
  because OpenRouter does not consistently expose cache headers (§5.2).
- **$/task** — derived from `tokens × OpenRouter prices` at the run snapshot, plus any
  AHC-internal LLM-call costs (Observer, digest generation, reflection).
- **p95 latency** — wall-clock time from user message to final assistant response.
- **Recall-tool usage rate** — fraction of tasks in which the agent invoked
  `recall_tool_result` at least once.
- **Per-class accuracy breakdown** — for AHC only, accuracy split by the detected
  trajectory class.

### 5.2 Experiment setup

**Provider.** All main experiments run on **OpenRouter** with a single API key and a
single billing surface. The primary actor model is `google/gemini-3-flash-preview`,
selected for cost and throughput. The LLM judge for evaluation is `openai/gpt-5.4` —
used only at evaluation time, not in the agent loop. Internal AHC LLM calls (Observer,
digest, reflection) default to the same Gemini-3-Flash, configurable per Mastra-style
`ModelByInputTokens` if needed.

**Cache-hit measurement.** Because OpenRouter does not reliably expose cache headers
across all model snapshots, the cache-hit rate metric (target ≥ 60% per
[@anthropic_compact_2026]) is measured on a separate **n = 10–15** subset of
LongMemEval-Medium tasks via the **direct Anthropic API** with
`claude-sonnet-4-6`. All other metrics use OpenRouter + Gemini-3-Flash.

**Seeds.** Two seeds — 42 (primary) and 43 (replication). Seeds affect task sampling for
LongMemEval-Medium and synthetic-top-up generation for AssistantTraj; baked subsets for
LoCoMo and τ-bench mirror their upstream `subset_ids.json`. The actor decode runs at
`temperature = 0` (greedy) for determinism; observed variance across seeds is small and
serves as a sanity replication check rather than the primary source of variance. Final
results report `mean ± stderr` across seeds.

**Statistical method.** Paired permutation test (`p < 0.05`) on the main deltas
between AHC and each baseline, pivoted by `task_id`. 95% bootstrap CI on the accuracy
delta is reported alongside the p-value.

**Cost discipline.** The eval harness includes a circuit breaker: cumulative spend
across the first 20 tasks is extrapolated to a projected budget; if projected > 1.5×
the per-sweep budget, the sweep halts cleanly with a `partial` summary status. All
sweep YAMLs commit explicit `SweepBudget` caps (`main_e1: $120`, `ablation_e2: $30`,
`cache_hit_e3: $20`).

**Reproducibility.** All four bench adapters and all baselines run inside a common
TypeScript harness in `src/eval/`. Sweep definitions live in `eval/sweeps/`. The
top-level command `./scripts/verify.sh` runs typecheck, lint, unit tests, and the
cache-invariance contract test in the AHC core. See Appendix A.

### 5.3 Baselines

We evaluate four configurations as primary baselines and four AHC ablation variants.

**Primary baselines (one per row, one per `config_id`):**

| # | Configuration                       | Description                                                  |
|---|-------------------------------------|--------------------------------------------------------------|
| 1 | `full_context`                      | No compaction; entire history replayed each turn. Accuracy upper bound, cost upper bound. |
| 2 | `anthropic_native`                  | Anthropic Messages API with `compact_20260112` server-side compaction strategy. |
| 3 | `mastra_om`                         | Mastra Observational Memory with default configuration (PG storage, observational memory enabled). Main competitor. |
| 4 | `ahc_full`                          | AHC with all default feature flags ON.                       |

Single-policy compaction strategies that the prior agent-generated study evaluated in
isolation (task-aware-only, type-aware-only, rolling-window, Mem0) are not re-run as
separate baselines here: their numbers are cited from [@holosophus_2026] in §6 with the
provenance disclosure of §2, and AHC ablations cover the same policy-class axes.

**Ablation variants (E2 sweep, two benches only):**

| # | Variant             | Disables                                          |
|---|---------------------|---------------------------------------------------|
| 5 | `ahc_task_only`     | `TYPE_AWARE_OFFLOAD = false`, `RECALL_TOOL = false` |
| 6 | `ahc_type_only`     | `TASK_AWARE_EXTRACTION = false`                   |
| 7 | `ahc_no_classifier` | `TRAJECTORY_CLASSIFIER = false`; force `mixed`    |
| 8 | `ahc_full` (E1 ref) | Sanity-cross with E1 numbers, within stderr        |

The ablation grid runs on LongMemEval-Medium (conversational class dominant) and τ-bench
retail (tool-heavy class dominant), where the policy-class routing matters most.

## 6. Results

<!--
RESULTS: this section is filled in F1b after the Track E sweeps complete.
Source files (do not invent):
  - benchmarks/runs/main-sweep/summary.json          (E1)
  - benchmarks/runs/ablations/summary.json           (E2)
  - benchmarks/runs/cache-hit-subset/summary.json    (E3)
Each table below has placeholder columns; numbers come from the source files above.
Numbers must be spot-checked against the underlying NDJSON during F1b (5% sample).
Per-class breakdown comes from `scripts/per-class-report.ts` (B3 helper).
-->

### 6.1 Main sweep (E1)

<!-- TABLE 6.1: 4 baselines × 4 benches. Rows = baselines, columns = benches.
     Cells = "accuracy ± stderr | tokens_p95 | $/task". Headline row in bold. -->

| Baseline             | LongMemEval-Med | LoCoMo-Med    | τ-bench retail   | AssistantTraj |
|----------------------|-----------------|---------------|------------------|---------------|
| `full_context`       | TBD             | TBD           | TBD              | TBD           |
| `anthropic_native`   | TBD             | TBD           | TBD              | TBD           |
| `mastra_om`          | TBD             | TBD           | TBD              | TBD           |
| **`ahc_full`**       | **TBD**         | **TBD**       | **TBD**          | **TBD**       |

<!-- Caption: "Accuracy on each of four benchmarks, with input p95 token budget and $/task.
     Mean ± stderr across seeds {42, 43}. Bold row is the proposed method." -->

Statistical significance — paired permutation `p < 0.05` and 95% bootstrap CI on the
deltas of interest — is reported inline once the sweep completes (F1b).

### 6.2 Pareto plots

![Figure 2: Pareto frontiers (accuracy × tokens) per benchmark; one subplot each.](figures/fig2_pareto.png)

### 6.3 Per-class accuracy breakdown (AHC)

![Figure 3: AHC accuracy split by the detected trajectory class.](figures/fig3_per_class.png)

<!-- TABLE 6.3: per-class accuracy. Generated by scripts/per-class-report.ts (B3). -->

| Trajectory class | n   | Accuracy   |
|------------------|-----|------------|
| conversational   | TBD | TBD        |
| tool_heavy       | TBD | TBD        |
| mixed            | TBD | TBD        |

### 6.4 Ablation grid (E2)

![Figure 4: Ablation comparison — AHC variants on LongMemEval-Med and τ-bench retail.](figures/fig4_ablations.png)

<!-- TABLE 6.4: ablation accuracy + $/task. Rows = variants, columns = (LongMemEval, τ-bench). -->

| Variant              | LongMemEval-Med | τ-bench retail |
|----------------------|-----------------|----------------|
| `ahc_full` (ref)     | TBD             | TBD            |
| `ahc_task_only`      | TBD             | TBD            |
| `ahc_type_only`      | TBD             | TBD            |
| `ahc_no_classifier`  | TBD             | TBD            |

### 6.5 Cache-hit rate (E3, Anthropic direct subset)

![Figure 5: Prompt cache-hit rate per baseline on the n=10–15 Anthropic direct subset.](figures/fig5_cache_hit.png)

<!-- TABLE 6.5: cache-hit rate per baseline, Sonnet-4.6 direct API. -->

| Baseline             | Cache hit rate | n  |
|----------------------|----------------|----|
| `anthropic_native`   | TBD            | TBD |
| `mastra_om`          | TBD            | TBD |
| `ahc_full`           | TBD            | TBD |

## 7. Discussion

<!--
DISCUSSION: §6 of F_report.md lists talking points. Skeleton headings here; bodies
filled in F1b/F2 with real deltas from the sweeps.
-->

### 7.1 Robustness across trajectory classes

<!-- TBD: argue that AHC does not collapse on any class. Concretely show τ-bench
     recovery from ~0 (single task-aware policy per [@holosophus_2026]) to AHC's
     measured number. Quote the recovery delta. -->

### 7.2 Pareto-dominance and where AHC wins versus where it does not

<!-- TBD: per-bench breakdown. For each bench, state which baseline AHC Pareto-dominates
     and by how much. Honest disclosure where AHC is competitive but not dominant. -->

### 7.3 Classifier accuracy and policy dispatch

<!-- TBD: if calibration traces had ground-truth class labels, report classifier
     accuracy. Tie misclassifications to per-class accuracy in §6.3. -->

### 7.4 Recall-tool usage and cost analysis

<!-- TBD: how often did the agent invoke recall_tool_result on tool-heavy benches?
     What fraction of $/task is AHC internal LLM calls (Observer, digest, reflection)
     versus the actor model? -->

### 7.5 Reflection-trigger frequency

<!-- TBD: on a 15-turn trajectory, how often does Tier-2 cross REFLECTION_THRESHOLD?
     If > 1× per medium-traj, the threshold should be revisited. -->

### 7.6 Comparison with prior agent-generated study

<!-- TBD: comparison with [@holosophus_2026]. Where do our numbers agree
     (task-aware Pareto-dominance on LongMemEval; τ-bench negative result), where do
     they diverge, and what is the most likely cause (smaller n, different actor model,
     adapter differences). Restate provenance disclosure briefly. -->

### 7.7 Limitations

- **Vendor-specific cache measurement.** Cache-hit numbers come from an n = 10–15
  Anthropic-direct subset; OpenRouter cache exposure is inconsistent across snapshots.
- **AssistantTraj scale.** n = 30–40 is small for strong claims on the multimodal axis;
  we report it as an internal benchmark for cross-class robustness rather than as an
  external SOTA target.
- **Classifier calibration.** The classifier thresholds are tuned on a small set of
  trajectories; broader calibration is left to future work (`CALIBRATION_AUTO` flag).
- **Prior agent-generated study.** As disclosed in §2, the cited study
  [@holosophus_2026] is fully agent-generated and was not subjected to human review;
  the numbers we cite from it are directional, not authoritative.

## 8. Conclusion

We presented **Adaptive Hybrid Compaction (AHC)** — middleware that classifies the
trajectory class on cheap features and routes between query-anchored extraction and
atomic-group offloading, packaged as AI SDK v6 middleware over a Mastra-inspired 3-tier
shape. The core claim is that **the right compaction policy is conditioned on the
trajectory class**, and that a lightweight rules-based classifier suffices to dispatch
between policies without sacrificing accuracy on any class.

<!--
CONCLUSION numbers (F1b): one-paragraph summary of headline deltas — Pareto-dominance
count out of four benches, τ-bench recovery from ~0, cache-hit ≥ 60%, ablation
confirmation. Plus a one-sentence pointer to repo + reproducibility appendix.
-->

**Future work** (consistent with `system_design §2.2`):

- **Cross-session memory layer.** AHC is single-session; combining it with a Mem0-style
  cross-session store is a natural extension.
- **Calibration automation.** The `CALIBRATION_AUTO` flag is implemented but defaults
  off — auto-tuning thresholds on a small ground-truth set is a near-term improvement.
- **Schema-aware digest.** With registered tool schemas, the digest could be projected
  rather than LLM-summarized — cheaper and more deterministic.
- **Long-horizon (15+ turns).** AHC is designed for medium-distance trajectories;
  long-horizon support (with more aggressive reflection scheduling) is non-goal here
  but worth measuring.
- **Cross-vendor robustness.** Our cross-vendor sanity is limited; broader actor-model
  sweeps would harden the policy-class claim.

## Appendix A. Reproducibility

**Repository.** <!-- REPO_URL placeholder (F3) -->

**Verification command.**

```
./scripts/verify.sh
```

This runs typecheck, lint, unit tests, and the AHC cache-invariance contract test.
Required to pass on the submission tag.

**Sweep definitions.**

- **E1 (main sweep):** `eval/sweeps/main_e1.yaml`, budget cap `$120`, 4 baselines × 4
  benches × 2 seeds.
- **E2 (ablations):** `eval/sweeps/ablation_e2.yaml`, budget cap `$30`, 4 AHC variants
  × 2 benches × 2 seeds.
- **E3 (cache-hit subset):** `eval/sweeps/cache_hit_e3.yaml`, budget cap `$20`, 3
  configurations × n = 10–15, on Anthropic direct API.

**Models pinned.** Snapshots fixed at sweep launch and recorded in each sweep's
`meta.json`.

- Actor model: `google/gemini-3-flash-preview` (snapshot TBD-F3).
- LLM judge: `openai/gpt-5.4` (evaluation only).
- Cache-hit subset actor: `anthropic/claude-sonnet-4-6`.
- AHC internal models (Observer, digest, reflection): `google/gemini-3-flash-preview`
  by default.

**Seeds.** 42 (primary), 43 (replication). Actor decode at `temperature = 0`.

**Data sources.**

- LongMemEval [@longmemeval_2024]: obtain via the upstream release; selection script
  in `scripts/bake-longmemeval.ts` reproduces our medium-subset sample.
- LoCoMo [@locomo_2024]: upstream release; selection in `scripts/bake-locomo.ts`.
- τ-bench [@taubench_2024]: upstream retail domain; selection in
  `scripts/bake-tau-bench.ts`.
- AssistantTraj: released in `benchmarks/assistant_traj/` with task fixtures, rubrics,
  and a provenance record per task.

**Statistical pipeline.** Paired permutation test (`task_id`-pivoted), 95% bootstrap
CI. Implementation in `src/eval/stats.ts`.

**Telemetry.** Per-turn records include `cache_read_input_tokens`, `compaction_events`,
`recall_events`, and the classifier `class_signal`. Records are NDJSON in
`benchmarks/runs/<sweep>/<bench>/<config>/<seed>/records.ndjson`; aggregate
`summary.json` and `meta.json` are committed.

**Optional observability.** Self-hosted Langfuse stack via
`observability/docker-compose.yml`. Set `LANGFUSE_ENABLED=true` to attach traces;
default off — runs are reproducible without it.

**License.** MIT (subject to course requirements).

---

<!--
END SENTINEL: post-F3 grep "TODO|TBD" report/main.md must return only the comment
markers above (HTML comments are stripped by most markdown viewers; final-pass
grep on rendered text must be clean).
-->
