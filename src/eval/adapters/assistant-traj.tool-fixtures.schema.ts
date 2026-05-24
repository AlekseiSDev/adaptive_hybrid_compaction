// AssistantTraj tool-fixture sidecar schema (Track J).
// Source of truth: docs/design/J_at_tools.md §2.1, §3.2, §4.2.
//
// Sidecar lives at `benchmarks/assistant_traj/tool_fixtures/<task_id>.json`.
// One fixture file per task with at least one expected_tool_calls entry.
// Replay dispatcher (assistant-traj.tools.ts, J2) consumes this shape.

import { z } from 'zod'

export const AT_TOOL_NAMES = ['image_gen', 'google_search', 'web_fetch', 'code_interpreter'] as const
export type AtToolName = (typeof AT_TOOL_NAMES)[number]

// Content parts emitted by replay tool output. Mirrors a narrowed subset of
// ContentPart from the task schema — replay produces only text + image + file
// (no nested tool_use / tool_result; tool outputs are leaves).
const TextOutputPartSchema = z.object({ type: z.literal('text'), text: z.string() })
const ImageOutputPartSchema = z.object({
  type: z.literal('image'),
  path: z.string().min(1),
  alt: z.string().optional(),
})
const FileOutputPartSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
  mime: z.string().optional(),
})

const OutputPartSchema = z.discriminatedUnion('type', [
  TextOutputPartSchema,
  ImageOutputPartSchema,
  FileOutputPartSchema,
])

const InputMatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('first') }),
  z.object({ kind: z.literal('args_subset'), args: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('args_exact'), args: z.record(z.string(), z.unknown()) }),
])

const ToolFixtureSchema = z.object({
  tool_name: z.enum(AT_TOOL_NAMES),
  input_match: InputMatchSchema.optional(),
  output_parts: z.array(OutputPartSchema).min(1),
  is_error: z.boolean().optional(),
})

// task_id pattern enforced here too — sidecar must reference the canonical AT
// task id so the validator can cross-check `<task_id>.json` filename pair.
const TaskIdRegex = /^at_(?:image_qa|code_iter|research_write|mixed)_\d{3}$/

export const ToolFixtureFileSchema = z.object({
  task_id: z.string().regex(TaskIdRegex, 'task_id must match at_<category>_<NNN>'),
  fixtures: z.array(ToolFixtureSchema).min(1),
})

export type ToolFixtureFile = z.infer<typeof ToolFixtureFileSchema>
export type ToolFixture = z.infer<typeof ToolFixtureSchema>
export type ToolFixtureOutputPart = z.infer<typeof OutputPartSchema>
export type ToolFixtureInputMatch = z.infer<typeof InputMatchSchema>
