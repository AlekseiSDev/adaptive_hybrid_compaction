# AssistantTraj benchmark

Multimodal medium-trajectory (5–15 turns) assistant benchmark used by the AHC eval
harness. **AT-v2 (Track J): 50 tool-grounded tasks** across four categories
(image_qa: 8, code_iter: 14, research_write: 14, mixed: 14). Each task declares
≥1 required tool call (palette: `image_gen`, `google_search`, `web_fetch`,
`code_interpreter`). Replay-default runtime (deterministic, CI-safe), live mode
opt-in via `AT_TOOL_MODE=live`.

Source-of-truth design: [`docs/design/D_assistant-traj.md`](../../docs/design/D_assistant-traj.md) (schema, layout, grader) +
[`docs/design/J_at_tools.md`](../../docs/design/J_at_tools.md) (tool palette, replay/live runtime, corpus migration).
Phase D1 shipped the JSON schema, storage layout, validator. D2/D3 populated
the initial `tasks/`. D4 wired the eval adapter + LLM-judge. Track J (J1–J6,
2026-05-22) introduced tool-grounded corpus + replay dispatcher.

## Schema

Every task in `tasks/*.json` conforms to `AssistantTrajTaskSchema` — see
[`src/eval/adapters/assistant-traj.schema.ts`](../../src/eval/adapters/assistant-traj.schema.ts)
for the authoritative Zod definition. Top-level shape (verbatim from design §2):

| Field | Notes |
|---|---|
| `task_id` | `at_<category>_<NNN>`; prefix must match `category`. |
| `category` | `image_qa` \| `code_iter` \| `research_write` \| `mixed`. |
| `source` | `real` \| `opensource` \| `synthetic`. |
| `turns[]` | Multimodal turn list (content parts: text / image / file / tool_use / tool_result). |
| `tools_available[]` | `ToolDefinition` list visible to the agent. |
| `evaluation` | Discriminated by `strategy`: `exact_match` / `regex` / `llm_judge` / `composite`. |
| `provenance` | Anonymization + review metadata. `provenance.anonymized_at` required when `source='real'`. |

## Layout

```
benchmarks/assistant_traj/
  tasks/             # .json — one task per file (50 AT-v2 drafts)
  tool_fixtures/     # .json — sidecar replay output per task (Track J)
  attachments/       # per-task images/files: attachments/<task_id>/...
  rubrics/           # rubrics/<category>.md (populated D4)
  calibration/       # human_scores.json (populated D4)
  fixtures/
    valid/           # D1 + J1 smoke fixtures — must parse OK
    invalid/         # D1 + J1 smoke fixtures — must fail with sidecar .reason.txt
  validate.ts        # CLI — see below
  README.md
```

### Sidecar tool fixtures (Track J)

Each task with at least one `required:true` entry in `expected_tool_calls`
must have a paired `tool_fixtures/<task_id>.json` sidecar:

```jsonc
{
  "task_id": "at_research_write_001",
  "fixtures": [
    { "tool_name": "google_search",
      "output_parts": [{ "type": "text", "text": "Top 3 results: ..." }] }
  ]
}
```

The replay dispatcher
([`src/eval/adapters/assistant-traj.tools.ts`](../../src/eval/adapters/assistant-traj.tools.ts))
consumes these on each tool call. Default matcher = `first` (order-based),
optional `args_exact` / `args_subset` per fixture entry. Missing fixture on a
required-tool call surfaces as `ToolReplayMissError` → `RunRecord.error =
'tool_replay_miss'`, not a silent pass.

### Replay vs Live

| Mode | Trigger | Determinism | Use case |
|---|---|---|---|
| **replay** (default) | none — default in every context | bit-stable | all sweeps, CI, eval A/B |
| **live** | `AT_TOOL_MODE=live` env | non-deterministic | local debug, fixture capture |

CI guard: `AT_TOOL_MODE=live` + `CI=true` → throws at adapter init (no silent
live runs during automated eval).

Live impls (OpenAI Images / Brave / fetch+readability / pyodide) are stubbed
out of MVP; capture-at-fixture helper lands as a J2/J4 stretch.

## Validator CLI

```sh
# Validate every tasks/*.json
pnpm tsx benchmarks/assistant_traj/validate.ts

# Validate only fixtures (D1 self-test)
pnpm tsx benchmarks/assistant_traj/validate.ts --fixtures

# Validate one task by id
pnpm tsx benchmarks/assistant_traj/validate.ts --task at_image_qa_001
```

Exit 0 if every file passes; exit 1 with a per-file failure summary otherwise.

Invalid fixtures pair each `.json` with a sibling `<name>.reason.txt`; the validator
verifies that the produced `ZodError.message` contains the expected substring. This
keeps invalid fixtures self-documenting regression tests.

## How to add a task

1. Pick `category` and the next free `NNN` index.
2. Copy a fixture from `fixtures/valid/` as a starting point.
3. Set `task_id` = `at_<category>_<NNN>`.
4. If `source = 'real'`: complete the anonymization checklist
   (design §4) **before** committing. Set `provenance.anonymized_at` to the
   ISO date when scrubbing finished, list applied steps in
   `provenance.anonymization_steps`, and add your initials + date to
   `provenance.review_signoff`.
5. Place attachments under `attachments/<task_id>/`; reference by relative path
   from `ContentPart.image.path` / `ContentPart.file.path`.
6. Validate: `pnpm tsx benchmarks/assistant_traj/validate.ts --task <task_id>`.
7. Commit task JSON + any attachments together.

Synthetic tasks (D3) require a non-empty `provenance.review_signoff` per the
design's 100% manual review gate.
