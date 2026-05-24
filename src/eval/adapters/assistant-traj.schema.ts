// AssistantTraj on-disk task schema. Source of truth: docs/design/D_assistant-traj.md §2.
// Validates JSON files in benchmarks/assistant_traj/tasks/. D4 adapter projects parsed
// objects into harness Task ({id, input, expected}); this schema covers the richer
// multimodal shape that lives on disk (turns[], multimodal content parts, evaluation
// strategies, provenance).

import { z } from 'zod'

const CATEGORIES = ['image_qa', 'code_iter', 'research_write', 'mixed'] as const
const SOURCES = ['real', 'opensource', 'synthetic'] as const

const TaskIdRegex = /^at_(?<category>image_qa|code_iter|research_write|mixed)_\d{3}$/

const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() })
const ImagePartSchema = z.object({
  type: z.literal('image'),
  path: z.string().min(1),
  alt: z.string().optional(),
})
const FilePartSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
  mime: z.string().optional(),
})
const ToolUsePartSchema = z.object({
  type: z.literal('tool_use'),
  tool_use_id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
})

// tool_result.content nests ContentPart[] — z.lazy keeps the recursion typeable.
const ContentPartSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('type', [
    TextPartSchema,
    ImagePartSchema,
    FilePartSchema,
    ToolUsePartSchema,
    ToolResultPartSchema,
  ]),
)

const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.array(ContentPartSchema),
  is_error: z.boolean().optional(),
})

const ToolCallExpectationSchema = z.object({
  tool_name: z.string().min(1),
  required: z.boolean().optional(),
  args_match: z.enum(['exact', 'subset', 'semantic']).optional(),
})

const TaskTurnSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.array(ContentPartSchema).min(1),
  expected_tool_calls: z.array(ToolCallExpectationSchema).optional(),
})

const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.unknown(),
})

const EvaluationExactMatchSchema = z.object({
  strategy: z.literal('exact_match'),
  expected: z.string(),
  case_sensitive: z.boolean().optional(),
})

const EvaluationRegexSchema = z.object({
  strategy: z.literal('regex'),
  pattern: z.string().min(1),
  flags: z.string().optional(),
})

const EvaluationLlmJudgeSchema = z.object({
  strategy: z.literal('llm_judge'),
  rubric_id: z.string().min(1),
  expected_summary: z.string(),
})

// Composite recurses through child EvaluationSpecs — z.lazy keeps the union typeable.
const EvaluationSpecSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('strategy', [
    EvaluationExactMatchSchema,
    EvaluationRegexSchema,
    EvaluationLlmJudgeSchema,
    EvaluationCompositeSchema,
  ]),
)

const EvaluationCompositeSchema = z.object({
  strategy: z.literal('composite'),
  rules: z.array(EvaluationSpecSchema),
  aggregate: z.enum(['all', 'any', 'mean']),
})

const ProvenanceSchema = z.object({
  anonymized_at: z.string().optional(),
  anonymization_steps: z.array(z.string()).optional(),
  original_session_hash: z.string().optional(),
  review_signoff: z.string().optional(),
})

const AssistantTrajTaskBaseSchema = z.object({
  task_id: z.string().regex(TaskIdRegex, 'task_id must match at_<category>_<NNN>'),
  category: z.enum(CATEGORIES),
  source: z.enum(SOURCES),
  turns: z.array(TaskTurnSchema).min(1),
  tools_available: z.array(ToolDefinitionSchema),
  evaluation: EvaluationSpecSchema,
  provenance: ProvenanceSchema,
  // Track J — optional pointer to sidecar fixture file. Absent ⇒ default
  // lookup `benchmarks/assistant_traj/tool_fixtures/<task_id>.json`.
  tool_fixtures_ref: z.string().min(1).optional(),
})

// Cross-field invariants (§2 + §4 + J §10.3):
//  1. task_id prefix must match the declared category.
//  2. source='real' requires non-empty provenance.anonymized_at (§4 final paragraph).
//  3. composite evaluation must have at least one rule (otherwise aggregate is vacuous).
//     Recurses into nested composite rules.
//  4. (Track J) if any turn has expected_tool_calls with required:true, then
//     tools_available must be non-empty AND every required tool_name must
//     appear in tools_available[].name. AT-v1 tasks (empty expected_tool_calls)
//     are unaffected — rule only activates when a required tool is declared.
export const AssistantTrajTaskSchema = AssistantTrajTaskBaseSchema.superRefine((task, ctx) => {
  const match = TaskIdRegex.exec(task.task_id)
  const idCategory = match?.groups?.['category']
  if (idCategory && idCategory !== task.category) {
    ctx.addIssue({
      code: 'custom',
      path: ['task_id'],
      message: `task_id category prefix '${idCategory}' does not match category field '${task.category}'`,
    })
  }

  if (task.source === 'real') {
    const anonymizedAt = task.provenance.anonymized_at
    if (!anonymizedAt || anonymizedAt.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'anonymized_at'],
        message: "source='real' requires non-empty provenance.anonymized_at",
      })
    }
  }

  checkComposite(task.evaluation, ['evaluation'], ctx)
  checkToolPalette(task, ctx)
})

function checkToolPalette(
  task: z.infer<typeof AssistantTrajTaskBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const requiredNames: { turnIdx: number; callIdx: number; name: string }[] = []
  task.turns.forEach((turn, turnIdx) => {
    const calls = turn.expected_tool_calls ?? []
    calls.forEach((call, callIdx) => {
      if (call.required === true) {
        requiredNames.push({ turnIdx, callIdx, name: call.tool_name })
      }
    })
  })
  if (requiredNames.length === 0) return

  if (task.tools_available.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tools_available'],
      message:
        'tools_available must be non-empty when any turn declares a required tool in expected_tool_calls',
    })
    return
  }

  const available = new Set(task.tools_available.map((t) => t.name))
  for (const req of requiredNames) {
    if (!available.has(req.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['turns', req.turnIdx, 'expected_tool_calls', req.callIdx, 'tool_name'],
        message: `required tool '${req.name}' not present in tools_available[].name`,
      })
    }
  }
}

function checkComposite(
  evaluation: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!evaluation || typeof evaluation !== 'object') return
  const ev = evaluation as { strategy?: unknown; rules?: unknown }
  if (ev.strategy !== 'composite') return
  if (!Array.isArray(ev.rules) || ev.rules.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'rules'],
      message: 'composite evaluation must have at least one rule',
    })
    return
  }
  ev.rules.forEach((rule, i) => {
    checkComposite(rule, [...path, 'rules', i], ctx)
  })
}

export type AssistantTrajTask = z.infer<typeof AssistantTrajTaskSchema>
export type AssistantTrajCategory = (typeof CATEGORIES)[number]
export type AssistantTrajSource = (typeof SOURCES)[number]
