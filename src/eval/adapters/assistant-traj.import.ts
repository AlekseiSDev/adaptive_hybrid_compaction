// Importer: jay-canvas golden-set scenario -> AssistantTrajTask skeleton.
// Source-of-truth design: docs/design/D_assistant-traj.md §3.1.
// Output is a 1-2 turn starter task; hand-extend to 5-15 turns before commit.
//
// Two shapes supported:
//  - Legacy `JayCanvasScenario` (single scenario file) — used by D2 importer
//    and existing test fixtures. importJayCanvasScenario() entrypoint.
//  - Run-export `GoldenSetScenario` (one entry inside runs/*.json from
//    apps/platform/api/e2e/golden-set/runs/v2.8-*.json) — Track J corpus
//    source. importGoldenSetScenario() entrypoint + tool palette mapping.

import {
  AssistantTrajTaskSchema,
  type AssistantTrajCategory,
  type AssistantTrajTask,
} from './assistant-traj.schema.js'
import {
  type AtToolName,
  TOOL_INPUT_SCHEMAS,
  TOOL_DESCRIPTIONS,
} from './assistant-traj.tools.js'
import type { ToolFixtureFile } from './assistant-traj.tool-fixtures.schema.js'

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

// ---- Track J: golden-set run-export importer -------------------------------
// jay-canvas runs/v2.8-*.json shape: { meta, scenarios: GoldenSetScenario[] }
// Each scenario = { id: 'A1', passed: bool, turns: [{ user_message, actual:
//   { tool_calls: string[], answer: string }, expected?: {...} }] }

export type GoldenSetTurn = {
  user_message: string
  actual?: {
    tool_calls?: string[]
    answer?: string
    model?: string
  }
  expected?: {
    tools?: { name: string }[] | string[]
    answer?: string
    answer_desc?: string
  }
}

export type GoldenSetScenario = {
  id: string
  passed: boolean
  turns: GoldenSetTurn[]
}

// jay-canvas tool name → AT-v2 palette (or null = out-of-palette, skip).
// edit_image folds into image_gen (same family — generation tool).
// get_image_content folds into web_fetch (vision content via URL fetch).
// generate_video / generate_music / text_to_speech — dropped.
const TOOL_PALETTE_MAP: Record<string, AtToolName | null> = {
  create_image: 'image_gen',
  edit_image: 'image_gen',
  google_search: 'google_search',
  browse_url: 'web_fetch',
  get_image_content: 'web_fetch',
  code_interpreter: 'code_interpreter',
  generate_video: null,
  generate_music: null,
  text_to_speech: null,
}

export function mapToolName(jcName: string): AtToolName | null {
  if (jcName in TOOL_PALETTE_MAP) {
    return TOOL_PALETTE_MAP[jcName] ?? null
  }
  return null
}

// id prefix → category. Extends CATEGORY_MAP (above) — same letters but
// distinct const so golden-set importer can evolve independently.
const ID_PREFIX_TO_CATEGORY: Record<string, AssistantTrajCategory> = {
  A: 'mixed',
  AM: 'mixed',
  MUS: 'mixed',
  MX: 'mixed',
  WC: 'mixed',
  CD: 'code_iter',
  DBG: 'code_iter',
  ED: 'research_write',
  QA: 'research_write',
  VG: 'image_qa',
  IG: 'image_qa',
  IE: 'image_qa',
}

export function inferCategoryFromGoldenId(id: string): AssistantTrajCategory | null {
  const prefix = /^[A-Za-z]+/.exec(id)?.[0]
  if (!prefix) return null
  return ID_PREFIX_TO_CATEGORY[prefix] ?? null
}

export type GoldenImportOptions = {
  scenario: GoldenSetScenario
  taskId: string
  category?: AssistantTrajCategory
  sourceFileBasename: string
  /**
   * If true, scenarios where no tool calls survive the palette mapping are
   * still imported (with empty expected_tool_calls + tools_available). Default
   * false — palette-empty scenarios are filtered out by callers (J3 corpus is
   * tool-grounded by definition).
   */
  keepEvenIfNoMappedTools?: boolean
}

export type GoldenImportResult = {
  task: AssistantTrajTask
  fixture: ToolFixtureFile
  downloads: DownloadMarker[]
}

// JSON-Schema skeleton for tools_available[].input_schema. Authored Zod lives
// in TOOL_INPUT_SCHEMAS; here we serialize the minimal { type:'object',
// properties:{}, required:[] } shell + flag-marker the underlying Zod schema
// via $description. Providers re-derive a richer JSON Schema if they want.
function toolInputSchemaPlaceholder(name: AtToolName): unknown {
  const description = TOOL_DESCRIPTIONS[name]
  // Tag with Zod presence so downstream code can re-hydrate if needed.
  void TOOL_INPUT_SCHEMAS[name] // keep import live; concrete shape exported separately
  return {
    type: 'object',
    description: `${description} (concrete shape: TOOL_INPUT_SCHEMAS.${name})`,
  }
}

/**
 * Convert a single golden-set scenario into an AT-v2 task + paired fixture
 * sidecar. Filters out-of-palette tools; if zero tools remain after mapping,
 * either skips (default) or imports an empty-tool task (with
 * `keepEvenIfNoMappedTools: true`).
 *
 * Caller responsibility:
 *  - Pick a free taskId (validate against existing tasks/ dir).
 *  - Hand-extend turns from the single jay-canvas user_message to medium-traj
 *    5–15 turns before merge (D §3.1 invariant). This importer outputs ONE
 *    user turn — the prompt — as the task seed.
 *  - Manually review the resulting JSON before commit (D §3.3 invariant).
 *
 * The fixture file contains stub output_parts (placeholder text) per
 * tool_call — capture-at-fixture.ts (J4) replaces with real outputs.
 */
export function importGoldenSetScenario(
  opts: GoldenImportOptions,
): GoldenImportResult | null {
  const { scenario, taskId, sourceFileBasename } = opts
  const category = opts.category ?? inferCategoryFromGoldenId(scenario.id)
  if (!category) {
    throw new Error(
      `cannot infer category for scenario id='${scenario.id}'; pass opts.category explicitly`,
    )
  }
  validateTaskIdAgainstCategory(taskId, category)

  // Aggregate tool_calls across all turns; map to palette; dedupe by first-seen
  // order so deterministic output. Keep order so downstream replay can replay
  // in scenario order.
  const mappedCalls: AtToolName[] = []
  for (const turn of scenario.turns) {
    const calls = turn.actual?.tool_calls ?? []
    for (const raw of calls) {
      const mapped = mapToolName(raw)
      if (mapped !== null && !mappedCalls.includes(mapped)) {
        mappedCalls.push(mapped)
      }
    }
  }

  if (mappedCalls.length === 0 && opts.keepEvenIfNoMappedTools !== true) {
    return null
  }

  const downloads: DownloadMarker[] = []
  let imageCounter = 0
  // Single seed-turn from the first scenario turn. The rest of jay-canvas
  // turns (rarely >1) are folded into the seed as continuation context if
  // present — but the importer doesn't try to reconstruct multi-turn flow.
  const firstTurn = scenario.turns[0]
  if (!firstTurn || firstTurn.user_message.length === 0) {
    return null
  }
  const { textWithoutUrls, extracted } = extractImageUrls(firstTurn.user_message)
  const content: AssistantTrajTask['turns'][number]['content'] = []
  for (const ex of extracted) {
    imageCounter += 1
    const targetPath = `attachments/${taskId}/${String(imageCounter)}.${ex.ext}`
    content.push({ type: 'image', path: targetPath })
    downloads.push({ url: ex.url, targetPath })
  }
  if (textWithoutUrls.length > 0) {
    content.push({ type: 'text', text: textWithoutUrls })
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: firstTurn.user_message })
  }

  const expected_tool_calls = mappedCalls.map((name) => ({
    tool_name: name,
    required: true as const,
    args_match: 'subset' as const,
  }))

  const userTurn: AssistantTrajTask['turns'][number] = expected_tool_calls.length > 0
    ? { role: 'user', content, expected_tool_calls }
    : { role: 'user', content }

  const tools_available = mappedCalls.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: toolInputSchemaPlaceholder(name),
  }))

  const expectedSummary =
    firstTurn.actual?.answer ?? firstTurn.expected?.answer_desc ?? ''
  // Truncate expected_summary to a manageable rubric length — judge rubric
  // (D §6.1) wants 1–3 sentence intent, not the whole answer.
  const summaryShort =
    expectedSummary.length > 600 ? `${expectedSummary.slice(0, 600).trim()}…` : expectedSummary

  const task: AssistantTrajTask = {
    task_id: taskId,
    category,
    source: 'opensource',
    turns: [userTurn],
    tools_available,
    evaluation: {
      strategy: 'llm_judge',
      rubric_id: category,
      expected_summary: summaryShort,
    },
    provenance: {
      original_session_hash: `${sourceFileBasename}::${scenario.id}`,
      // J3 audit: explicit signoff marker — '<draft>' means importer output,
      // not yet manually reviewed. J4 / J6 manual review pass replaces with
      // a real signoff stamp.
      review_signoff: '<draft: jay-canvas import; needs hand-extension + review>',
    },
  }

  // Paired fixture sidecar — placeholder output_parts. capture-at-fixture.ts
  // (J4 helper) replaces with live tool output bytes before final commit.
  const fixture: ToolFixtureFile = {
    task_id: taskId,
    fixtures: mappedCalls.map((tool_name) => ({
      tool_name,
      output_parts: [
        {
          type: 'text',
          text: `<placeholder output for ${tool_name} — to be filled by capture-at-fixture or manual edit>`,
        },
      ],
    })),
  }

  return {
    task: AssistantTrajTaskSchema.parse(task),
    fixture,
    downloads,
  }
}

export type GoldenSetRunFile = {
  meta?: Record<string, unknown>
  scenarios: GoldenSetScenario[]
}

/**
 * Allocate task_ids per category for a batch of golden-set scenarios.
 * Returns a Map<scenario.id, taskId> respecting the at_<category>_NNN
 * convention. Skips scenarios that map to no tools (and `skipPaletteEmpty`
 * is true — default).
 */
export function allocateTaskIds(
  scenarios: GoldenSetScenario[],
  opts: {
    perCategoryCap?: Partial<Record<AssistantTrajCategory, number>>
    skipPaletteEmpty?: boolean
  } = {},
): Map<string, string> {
  const counter: Record<AssistantTrajCategory, number> = {
    image_qa: 0,
    code_iter: 0,
    research_write: 0,
    mixed: 0,
  }
  const cap = opts.perCategoryCap ?? {}
  const out = new Map<string, string>()
  for (const s of scenarios) {
    const cat = inferCategoryFromGoldenId(s.id)
    if (!cat) continue
    if (opts.skipPaletteEmpty !== false) {
      const anyMapped = s.turns.some((t) =>
        (t.actual?.tool_calls ?? []).some((tc) => mapToolName(tc) !== null),
      )
      if (!anyMapped) continue
    }
    counter[cat] += 1
    if (cap[cat] !== undefined && counter[cat] > cap[cat]) {
      counter[cat] -= 1
      continue
    }
    out.set(s.id, `at_${cat}_${String(counter[cat]).padStart(3, '0')}`)
  }
  return out
}
