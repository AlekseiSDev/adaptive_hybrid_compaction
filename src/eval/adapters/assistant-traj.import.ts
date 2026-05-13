// Importer: jay-canvas golden-set scenario -> AssistantTrajTask skeleton.
// Source-of-truth design: docs/design/D_assistant-traj.md §3.1.
// Output is a 1-2 turn starter task; hand-extend to 5-15 turns before commit.

import {
  AssistantTrajTaskSchema,
  type AssistantTrajCategory,
  type AssistantTrajTask,
} from './assistant-traj.schema.js'

export type JayCanvasToolCall = {
  name: string
  input?: unknown
}

export type JayCanvasTurn = {
  user: string
  expected: {
    tools?: JayCanvasToolCall[]
    answer?: string | null
    answer_desc?: string
    tool_outputs?: Record<string, unknown>
  }
  datetime_reminder?: string
  model_parameters?: unknown
}

export type JayCanvasScenario = {
  scenario: string
  card_type?: string
  model?: string
  payload_model?: string
  captured_at?: string
  captured_git_commit?: string
  turns: JayCanvasTurn[]
}

export type DownloadMarker = {
  url: string
  targetPath: string
}

export type ImportOptions = {
  scenarioId: string
  sourceCategory: string
  sourceFileBasename: string
  taskId: string
  category?: AssistantTrajCategory
}

export type ImportResult = {
  task: AssistantTrajTask
  downloads: DownloadMarker[]
}

const CATEGORY_MAP: Record<string, AssistantTrajCategory> = {
  A: 'mixed',
  AM: 'mixed',
  MUS: 'mixed',
  MX: 'mixed',
  CD: 'code_iter',
  DBG: 'code_iter',
  WC: 'code_iter',
  VG: 'image_qa',
  IG: 'image_qa',
  IE: 'image_qa',
  ED: 'research_write',
  QA: 'research_write',
}

const TASK_ID_RE =
  /^at_(image_qa|code_iter|research_write|mixed)_(\d{3})$/

const IMAGE_URL_RE =
  /https?:\/\/\S+?\.(svg|png|jpe?g|gif|webp)(\?\S*)?(?=\s|$)/gi

export function importJayCanvasScenario(
  scenario: JayCanvasScenario,
  opts: ImportOptions,
): ImportResult {
  const category = resolveCategory(opts)
  validateTaskIdAgainstCategory(opts.taskId, category)

  const downloads: DownloadMarker[] = []
  let imageCounter = 0

  const turns: AssistantTrajTask['turns'] = scenario.turns.map((rawTurn) => {
    const content: AssistantTrajTask['turns'][number]['content'] = []
    const { textWithoutUrls, extracted } = extractImageUrls(rawTurn.user)
    for (const ex of extracted) {
      imageCounter += 1
      const targetPath = `attachments/${opts.taskId}/${String(imageCounter)}.${ex.ext}`
      content.push({ type: 'image', path: targetPath })
      downloads.push({ url: ex.url, targetPath })
    }
    if (textWithoutUrls.length > 0) {
      content.push({ type: 'text', text: textWithoutUrls })
    }
    if (content.length === 0) {
      // Defensive: ensure at least one part for schema's content.min(1).
      content.push({ type: 'text', text: rawTurn.user })
    }

    const expectedTools = rawTurn.expected.tools ?? []
    const expected_tool_calls =
      expectedTools.length > 0
        ? expectedTools.map((t) => ({
            tool_name: t.name,
            required: true,
            args_match: 'semantic' as const,
          }))
        : undefined

    return expected_tool_calls
      ? { role: 'user' as const, content, expected_tool_calls }
      : { role: 'user' as const, content }
  })

  const toolNames = new Set<string>()
  for (const t of scenario.turns) {
    for (const tool of t.expected.tools ?? []) {
      toolNames.add(tool.name)
    }
  }
  const tools_available = [...toolNames].map((name) => ({
    name,
    input_schema: {},
  }))

  const lastTurn = scenario.turns[scenario.turns.length - 1]
  const expectedSummary = lastTurn?.expected.answer ?? lastTurn?.expected.answer_desc ?? ''

  const task: AssistantTrajTask = {
    task_id: opts.taskId,
    category,
    source: 'opensource',
    turns,
    tools_available,
    evaluation: {
      strategy: 'llm_judge',
      rubric_id: category,
      expected_summary: expectedSummary,
    },
    provenance: {
      original_session_hash: `${opts.sourceFileBasename}::${opts.scenarioId}`,
    },
  }

  return { task: AssistantTrajTaskSchema.parse(task), downloads }
}

function resolveCategory(opts: ImportOptions): AssistantTrajCategory {
  if (opts.category) return opts.category
  const fromMap = CATEGORY_MAP[opts.sourceCategory]
  if (!fromMap) {
    throw new Error(
      `unknown source-category '${opts.sourceCategory}' — extend CATEGORY_MAP or pass --category`,
    )
  }
  return fromMap
}

function validateTaskIdAgainstCategory(
  taskId: string,
  category: AssistantTrajCategory,
): void {
  const match = TASK_ID_RE.exec(taskId)
  if (!match) {
    throw new Error(`task_id '${taskId}' does not match at_<category>_<NNN>`)
  }
  const prefix = match[1]
  if (prefix !== category) {
    throw new Error(
      `task_id prefix '${String(prefix)}' does not match category '${category}'`,
    )
  }
}

type ExtractedImage = { url: string; ext: string }

function extractImageUrls(text: string): {
  textWithoutUrls: string
  extracted: ExtractedImage[]
} {
  const extracted: ExtractedImage[] = []
  let stripped = text
  const matches = [...text.matchAll(IMAGE_URL_RE)]
  for (const m of matches) {
    const url = m[0]
    const ext = normaliseExt(m[1] ?? '')
    extracted.push({ url, ext })
    stripped = stripped.replace(url, '')
  }
  stripped = stripped.replace(/\s+/g, ' ').trim()
  return { textWithoutUrls: stripped, extracted }
}

function normaliseExt(raw: string): string {
  const lower = raw.toLowerCase()
  return lower === 'jpeg' ? 'jpg' : lower
}
