# AssistantTraj benchmark

Multimodal medium-trajectory (5–15 turns) assistant benchmark used by the AHC eval
harness. 30–40 anonymized tasks across four categories (image_qa, code_iter,
research_write, mixed).

Source-of-truth design: [`docs/design/D_assistant-traj.md`](../../docs/design/D_assistant-traj.md).
Phase D1 ships the JSON schema, storage layout, and a validator. D2/D3 populate
`tasks/` (real + open-source + synthetic). D4 wires the eval adapter + LLM-judge.

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
  tasks/             # .json — one task per file (populated D2/D3)
  attachments/       # per-task images/files: attachments/<task_id>/...
  rubrics/           # rubrics/<category>.md (populated D4)
  calibration/       # human_scores.json (populated D4)
  fixtures/
    valid/           # D1 smoke fixtures — must parse OK
    invalid/         # D1 smoke fixtures — must fail with sidecar .reason.txt
  validate.ts        # CLI — see below
  README.md
```

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
