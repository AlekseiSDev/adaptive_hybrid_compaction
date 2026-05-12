# Investigation: Anthropic `compact_20260112` API shape for C2

## Meta

- **Date Created:** 2026-05-13
- **Date Updated:** 2026-05-13
- **Status:** Completed
- **Related:** `design/C_baselines.md §3` (Anthropic native compact wrapper),
  `design/B_eval-harness.md §3` (TurnRecord shape), Track C plan
  `~/.claude/plans/cozy-greeting-acorn.md`, `decisions.md 2026-05-13` (B2 —
  Anthropic direct deferred to E3; C2 lands first Anthropic SDK usage).

## Goal

C2 (`AnthropicNativeBaseline`) wrap'ает Anthropic Messages API с server-side
`compact_20260112` strategy. Design doc был написан в исследовательский
момент когда shape API не был стабилен. Цель — verify фактический shape в
`@anthropic-ai/sdk@0.95.2`, выбрать model id, понять формат response
compaction events для `compaction_event` telemetry mapping.

## Problem Statement

- **Observation:** `design/C_baselines.md §3` pseudocode передаёт `metadata:
  { compact_strategy: 'compact_20260112' }` в request и ожидает
  `response.metadata.compacted_history_id` для session-id-based round-trip.
- **Manifestation:** mapping `compact_20260112` response → `CompactionEvent
  { before_bytes, after_bytes }` зависит от реальной структуры response.
  Без verify пишем speculation вместо implementation.
- **Why a problem:** C2 — vendor-exception baseline (весь проект на Gemini,
  C2 единственный использует Anthropic). Если API shape резко отличается
  от design — нужно ревизить scope, реальная work уходит на адаптацию.
- **Known facts:** Anthropic SDK `0.95.2` published Q2 2026; bundled types
  должны точно отражать current API.

## Scope

- **In scope:** verify (а) `compact_20260112` exists in SDK types, (б) точная
  shape request param, (в) точная shape response, (г) model id для тестов,
  (д) round-trip mechanism между turns.
- **Out of scope:** prompt caching shape (отдельная фича — `cache_control`,
  trackится отдельно в `cache_read_input_tokens` через `mapAnthropicUsage`);
  multi-edit pipelines (`clear_tool_uses_20250919` etc — могут быть combined
  с `compact_20260112` но scope V1 — только compact).
- **Constraints:** real-LLM live test нужен `ANTHROPIC_API_KEY` (manual gate).

## Hypotheses

| ID | Hypothesis | Why plausible | How to validate | Status |
|---|---|---|---|---|
| H1 | `compact_20260112` exists in SDK types | Design написан по этому имени | grep SDK types | confirmed |
| H2 | Lives under `beta.messages` (not stable `messages`) | Strategy date suggests 2026 launch | grep `beta/messages/` | confirmed |
| H3 | Request shape uses `metadata.compact_strategy` field | Design's pseudocode | grep request body type | rejected |
| H4 | Response returns `compacted_history_id` for session round-trip | Design's pseudocode | grep response type | rejected |
| H5 | `claude-sonnet-4-6` is a valid SDK model literal | Design's model choice | grep `Model` union | confirmed |

## Evidence

```
$ npm view @anthropic-ai/sdk version
0.95.2

$ npm view @anthropic-ai/sdk peerDependencies
peerDependencies = { zod: '^3.25.0 || ^4.0.0' }     # OK, project zod ^4

$ grep -rn 'compact_20260112' node_modules/@anthropic-ai/sdk/
node_modules/.../beta/messages/messages.d.ts:665:    type: 'compact_20260112';
node_modules/.../models.d.ts:47:    compact_20260112: CapabilitySupport | null;
node_modules/.../beta/models.d.ts:62:    compact_20260112: BetaCapabilitySupport | null;

# beta/messages/messages.d.ts shape:
export interface BetaCompact20260112Edit {
    type: 'compact_20260112';
    instructions?: string | null;
    pause_after_compaction?: boolean;
    trigger?: BetaInputTokensTrigger | null;   // default 150000 input tokens
}

# Request body:
context_management?: BetaContextManagementConfig | null
BetaContextManagementConfig = {
    edits?: Array<
      BetaClearToolUses20250919Edit
      | BetaClearThinking20251015Edit
      | BetaCompact20260112Edit
    >
}

# Response body (in BetaMessage):
context_management: BetaContextManagementResponse | null
# applied_edits на compact НЕ перечислены — compact выдаётся как content block, не как edit applied_edits:
BetaContextManagementResponse = {
    applied_edits: Array<
      BetaClearToolUses20250919EditResponse
      | BetaClearThinking20251015EditResponse
    >   # Note: compact response NOT in this list
}

# Compaction surface in content blocks:
BetaCompactionBlock = {
    type: 'compaction'
    content: string | null               # summary of compacted content
    encrypted_content: string | null     # opaque, round-trip in next request
}
# Docs: "Users should round-trip these blocks from responses to subsequent
# requests to maintain context across compaction boundaries."

# Per-iteration usage (when compaction fires):
BetaCompactionIterationUsage = {
    cache_creation: BetaCacheCreation | null
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    input_tokens: number
    output_tokens: number
    # plus extra fields for compaction iteration breakdown
}

# Model union (stable + beta):
type Model = 'claude-opus-4-7' | 'claude-mythos-preview'
  | 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5'
  | 'claude-haiku-4-5-20251001' | ... | (string & {})
# claude-sonnet-4-6 — valid literal ✓
```

## Findings

| Source | Result | Confidence | Notes |
|---|---|---|---|
| SDK 0.95.2 types | `compact_20260112` exists under `client.beta.messages.*` | high | Lives in `beta`, not stable `messages` — must use `client.beta.messages.create({...})` |
| Request shape | `context_management.edits[]` с `BetaCompact20260112Edit` | high | NOT `metadata.compact_strategy` per design |
| Trigger | `trigger?: BetaInputTokensTrigger` default 150000 input tokens | high | Lower trigger → testable in shorter convos |
| Response shape | `BetaCompactionBlock` в content (не `compacted_history_id`) | high | Block has `encrypted_content` (opaque), round-tripped в next request as part of conversation history |
| Round-trip mechanism | Echo `BetaCompactionBlock` обратно в `messages[]` следующего request'а | high | Maintains context across compaction boundaries; не session-id |
| Model | `claude-sonnet-4-6` — valid literal в Model union | high | Verified |
| Compaction-event mapping | `before_bytes/after_bytes` derive из `BetaCompactionIterationUsage.input_tokens` (or stringification compare) | medium | Token-level metric — bytes = chars в compaction block content ≈ token approximation; для post-hoc analysis сойдёт |

## Interpretation

**Design corrections required (deviation from `C_baselines.md §3`):**

1. **H3 rejected:** Request param — `context_management: { edits: [{ type: 'compact_20260112', ... }] }`, не `metadata: { compact_strategy: ... }`. Design's API guess was wrong.
2. **H4 rejected:** Round-trip — через `BetaCompactionBlock` content blocks (echoed in subsequent requests' `messages[]`), не через `compacted_history_id` session id. Design's session-id assumption was wrong.
3. **H1, H2, H5 confirmed:** strategy exists; on beta endpoint; model literal valid.

**Implementation implications:**

- Use `client.beta.messages.create()` (not `client.messages.create()`).
- Pass `context_management.edits` array containing one `BetaCompact20260112Edit` with low `trigger` (e.g., 4000 input tokens) for testability on short convos.
- Track `BetaCompactionBlock` blocks в `state.scratch.compaction_blocks: BetaCompactionBlock[]` — at next step, prepend them to outgoing `messages[]` to maintain compaction context.
- `compaction_event` telemetry mapping: emit per turn — if response contains `BetaCompactionBlock`, fire `{ type: 'reflection', before_bytes: <pre-compact total>, after_bytes: <post-compact block content size> }`. Pre-compact total = sum of chars in `state.history` outgoing message contents.
- Token usage: standard `BetaUsage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` (re-use existing `mapAnthropicUsage` from `src/eval/telemetry.ts`).

**Vendor-exception caveat (per user direction 2026-05-13):**

C2 — единственный non-Gemini baseline в проекте. system_design.md §6.1 явно
говорит "Provider: OpenRouter для всех experiments". C2 — vendor exception
потому что `compact_20260112` server-side feature exists **только у Anthropic**;
cross-vendor сравнение (Anthropic vs Gemini-based AHC) — каviat в Report
Discussion section (F2 / F3). C2 не выполняется на main sweep если
`ANTHROPIC_API_KEY` отсутствует — gate на runtime в `defaultRunnerRegistry`.

## Next Actions

- **Action:**
  1. Импорт `Anthropic` from `@anthropic-ai/sdk@0.95.2`.
  2. Implement `anthropicCompactBaseline(deps)` в `src/eval/baselines/anthropic_compact.ts`:
     - `prepare(task)` → state с `scratch = { compaction_blocks: BetaCompactionBlock[], model: 'claude-sonnet-4-6' }`.
     - `step(state, userMsg)` → `client.beta.messages.create({ model, max_tokens, messages: [...echo compaction_blocks, ...state.history, userMsg], context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 4000 } }] } })`.
     - Extract `BetaCompactionBlock` from response.content → push into `state.scratch.compaction_blocks` for next turn.
     - Emit `compaction_event` если block присутствует.
  3. Register `anthropic_compact` в `defaultRunnerRegistry` (gate `ANTHROPIC_API_KEY`).
  4. Unit tests с mocked Anthropic client (no real key needed).
  5. Live test skip-marked без `ANTHROPIC_API_KEY`.

- **Verification:** `pnpm exec vitest run src/eval/baselines/anthropic_compact.test.ts`
  с `ANTHROPIC_API_KEY` → step()-roundtrip live; `compaction_event` логируется
  при triggered compaction.

- **Decision entries (`decisions.md`):**
  ```
  - **[2026-05-13] C2 — Anthropic vendor-exception для server-side compaction baseline**:
    `system_design.md §6.1` гласит "Provider: OpenRouter для всех experiments";
    C2 — единственный non-Gemini baseline потому что `compact_20260112` server-side
    feature существует только у Anthropic. Cross-vendor caveat — Report Discussion.
    Runtime gate: `defaultRunnerRegistry` throws если `ANTHROPIC_API_KEY` missing
    на `baseline: anthropic_compact`. Model — `claude-sonnet-4-6`. Token comparisons
    cross-provider — approximate, не apples-to-apples.

  - **[2026-05-13] C2 — Anthropic compact API shape: `context_management.edits[]` + `BetaCompactionBlock` round-trip (не design's `metadata.compact_strategy` + `compacted_history_id`)**:
    Investigation `docs/investigations/anthropic-compact-shape.md` reject'ил
    design's API guess. Real request shape — `client.beta.messages.create({
    context_management: { edits: [{ type: 'compact_20260112', trigger,
    instructions?, pause_after_compaction? }] } })`. Real round-trip — через
    `BetaCompactionBlock` content blocks (echoed в `messages[]` следующего
    request'а), не session id. `state.scratch.compaction_blocks: BetaCompactionBlock[]`
    держит эти blocks; `step()` prepend'ит их в outgoing messages. Endpoint —
    `client.beta.messages.*`, не stable `client.messages.*`.
  ```

- **Harness entry:** Не требуется — one-off исследование. Design docs (C_baselines.md §3) обновятся inline в C2 imp commit.
