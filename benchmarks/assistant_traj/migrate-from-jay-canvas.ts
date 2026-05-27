#!/usr/bin/env tsx
// D6 — AT-v3 corpus rebuild from jay-canvas golden-set.
// Source of truth: docs/design/D_assistant-traj.md §3.1 + Phase Map D6.
//
// Reads jay-canvas/apps/platform/api/e2e/golden-set/scenarios/*.json and emits
// conformant AT-v3 task JSON + sidecar fixtures into benchmarks/assistant_traj/.
//
// Usage:
//   pnpm tsx benchmarks/assistant_traj/migrate-from-jay-canvas.ts --dry-run
//   pnpm tsx benchmarks/assistant_traj/migrate-from-jay-canvas.ts --write
//
// Skips MUS / VG / AM (video/music/audio per user 2026-05-27 plan).
//
// Idempotent: re-running --write overwrites the at_*_jc_* task / fixture / attachment
// files it owns; never touches AT-v2 legacy `at_<cat>_<NNN>.json` files (those are
// retired in a separate step).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  AssistantTrajTaskSchema,
  type AssistantTrajCategory,
} from '../../src/eval/adapters/assistant-traj.schema.js'
import {
  AT_TOOL_NAMES,
  type AtToolName,
  ToolFixtureFileSchema,
} from '../../src/eval/adapters/assistant-traj.tool-fixtures.schema.js'

// ---- Paths ---------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const AT_ROOT = join(REPO_ROOT, 'benchmarks/assistant_traj')
const JAY_GOLDEN_SET = resolve(
  import.meta.dirname,
  '../../../jay-canvas/apps/platform/api/e2e/golden-set/scenarios',
)

const TARGET_SECTIONS = ['A', 'CD', 'DBG', 'ED', 'IE', 'IG', 'MX', 'QA', 'WC'] as const
type JaySection = (typeof TARGET_SECTIONS)[number]

// ---- Category mapping (decided in plan 2026-05-27) ----------------------

const SECTION_TO_CATEGORY: Record<JaySection, AssistantTrajCategory> = {
  A: 'research_write',
  CD: 'code_iter',
  DBG: 'mixed',
  ED: 'research_write',
  IE: 'image_qa',
  IG: 'image_qa',
  MX: 'mixed',
  QA: 'research_write',
  WC: 'research_write',
}

// ---- Tool name mapping --------------------------------------------------

const JAY_TOOL_TO_AT: Partial<Record<string, AtToolName>> = {
  create_image: 'image_gen',
  edit_image: 'image_edit',
  google_search: 'google_search',
  code_interpreter: 'code_interpreter',
  // web_fetch passes through if jay-canvas ever uses it
  web_fetch: 'web_fetch',
}

function mapJayTool(name: string): AtToolName | null {
  return JAY_TOOL_TO_AT[name] ?? null
}

// ---- jay-canvas shape ---------------------------------------------------

type JayTurn = {
  user: string
  expected: {
    tools?: string[]
    answer?: string
    answer_desc?: string
  }
  tool_outputs?: Record<string, unknown>
  // history exists on follow-up turns but we don't need it for reroll mode
  history?: unknown
}

type JayScenario = {
  scenario: string
  card_type: string
  model?: string
  payload_model?: string
  captured_at?: string
  captured_git_commit?: string
  turns: JayTurn[]
}

type JaySectionFile = {
  section: string
  description?: string
  scenarios: Record<string, JayScenario>
}

// ---- Conversion ---------------------------------------------------------

const ANONYMIZATION_NOTE =
  'source: user-owned jay-canvas production traces; no third-party PII per author review'
const TODAY = '2026-05-27'

type ConvertedTask = {
  taskJson: unknown
  fixtureJson: unknown | null
  jayKey: string
  category: AssistantTrajCategory
}

function buildTaskId(
  category: AssistantTrajCategory,
  section: JaySection,
  nnn: number,
): string {
  const sec = section.toLowerCase()
  const padded = String(nnn).padStart(3, '0')
  return `at_${category}_jc_${sec}_${padded}`
}

function buildToolsAvailable(toolNames: readonly AtToolName[]): unknown[] {
  return toolNames.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS_REPLICA[name],
    input_schema: {
      type: 'object',
      description: `${TOOL_DESCRIPTIONS_REPLICA[name]} (concrete shape: TOOL_INPUT_SCHEMAS.${name})`,
    },
  }))
}

// Replica of TOOL_DESCRIPTIONS from src/eval/adapters/assistant-traj.tools.ts.
// Kept local to avoid cycle into a src module that depends on Zod runtime.
const TOOL_DESCRIPTIONS_REPLICA: Record<AtToolName, string> = {
  image_gen:
    'Generate an image from a text prompt. Returns image URL plus short caption.',
  image_edit:
    'Edit an existing image per a natural-language instruction. Returns new image URL plus short caption.',
  google_search:
    'Web search via Google. Returns top-N results as title+snippet+URL list.',
  web_fetch:
    'Fetch a web page and return cleaned main content as Markdown. HTML only.',
  code_interpreter:
    'Execute Python 3 code in a sandbox. Returns stdout, stderr, and exit code.',
}

function fixtureTextForCapturedOutput(
  toolName: AtToolName,
  captured: unknown,
): string {
  // Each tool has a deterministic text shape (J §3.2). Migrator best-effort
  // formats captured jay-canvas output into that shape; bake-fixtures replaces
  // any entry marked needs_bake with the live wrapper's exact output later.
  if (toolName === 'image_gen' || toolName === 'image_edit') {
    const c = captured as { image_url?: string } | null
    const url = c?.image_url ?? '<unknown>'
    return toolName === 'image_gen'
      ? `Generated image: ${url}\nCaption: (captured from jay-canvas)`
      : `Edited image: ${url}\nCaption: (captured from jay-canvas)\nSource: (captured)`
  }
  if (toolName === 'google_search') {
    if (Array.isArray(captured)) {
      const items = captured
        .slice(0, 10)
        .map((r, i) => {
          const o = r as { text?: string; link?: string }
          return `${String(i + 1)}. ${o.text ?? '(no title)'}\n   ${o.link ?? ''}`
        })
        .join('\n')
      return `Top ${String(Math.min(captured.length, 10))} results:\n${items}`
    }
    return `Top 0 results:\n(captured shape unknown — re-bake)`
  }
  if (toolName === 'web_fetch') {
    const c = captured as { content?: string; title?: string } | null
    return `# ${c?.title ?? ''}\n\n${c?.content ?? ''}`
  }
  // code_interpreter
  const c = captured as { stdout?: string; stderr?: string } | null
  return `STDOUT:\n${c?.stdout ?? ''}\n\nSTDERR:\n${c?.stderr ?? ''}\n\nExit: 0`
}

function convertScenario(
  section: JaySection,
  jayKey: string,
  scenario: JayScenario,
  nnn: number,
): ConvertedTask {
  const category = SECTION_TO_CATEGORY[section]
  const task_id = buildTaskId(category, section, nnn)

  // 1. Tools palette — union of all expected tool names across turns, mapped to AT names.
  const usedAtTools = new Set<AtToolName>()
  for (const turn of scenario.turns) {
    for (const jayName of turn.expected.tools ?? []) {
      const at = mapJayTool(jayName)
      if (at) usedAtTools.add(at)
    }
  }
  const toolsAvailable = buildToolsAvailable([...usedAtTools].sort())

  // 2. Turns — one user-turn per jay-canvas turn (reroll mode plays them sequentially).
  //    expected_tool_calls per turn list required:true for each mapped tool.
  const turns = scenario.turns.map((t) => {
    const expectedToolCalls = (t.expected.tools ?? [])
      .map((name) => {
        const at = mapJayTool(name)
        return at
          ? { tool_name: at, required: true, args_match: 'subset' as const }
          : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    const turn: Record<string, unknown> = {
      role: 'user' as const,
      content: [{ type: 'text', text: t.user }],
    }
    if (expectedToolCalls.length > 0) turn['expected_tool_calls'] = expectedToolCalls
    return turn
  })

  // 3. Evaluation — judge on FINAL turn's expected.answer (multi-turn arc ends there).
  //    Empty / missing answer falls back to answer_desc (rare for v1 of corpus).
  const lastTurn = scenario.turns[scenario.turns.length - 1]
  const expected_summary =
    lastTurn?.expected.answer ?? lastTurn?.expected.answer_desc ?? ''

  // 4. Provenance.
  const lineageHash = `${scenario.scenario}@${scenario.captured_git_commit ?? 'unknown'}`

  const taskJson = {
    task_id,
    category,
    source: 'real' as const,
    turns,
    tools_available: toolsAvailable,
    evaluation: {
      strategy: 'llm_judge' as const,
      rubric_id: category,
      expected_summary,
    },
    // execution_mode defaults to 'reroll' if turns.length > 1 (adapter side).
    // We don't set it explicitly — keeps JSON clean and follows the schema default.
    provenance: {
      anonymized_at: TODAY,
      anonymization_steps: [ANONYMIZATION_NOTE],
      original_session_hash: lineageHash,
      review_signoff: `migrated from jay-canvas (${jayKey}) on ${TODAY} by D6 migrator`,
    },
  }

  // 5. Sidecar fixtures (only if any required tool).
  const fixtures: unknown[] = []
  scenario.turns.forEach((turn) => {
    for (const jayName of turn.expected.tools ?? []) {
      const at = mapJayTool(jayName)
      if (!at) continue
      const captured = turn.tool_outputs?.[jayName]
      if (captured === undefined) {
        fixtures.push({
          tool_name: at,
          output_parts: [
            {
              type: 'text',
              text: `[needs_bake] live capture pending for ${at}; bake-fixtures.ts will replace`,
            },
          ],
          needs_bake: true,
        })
      } else {
        fixtures.push({
          tool_name: at,
          output_parts: [{ type: 'text', text: fixtureTextForCapturedOutput(at, captured) }],
        })
      }
    }
  })
  const fixtureJson = fixtures.length > 0 ? { task_id, fixtures } : null

  return { taskJson, fixtureJson, jayKey, category }
}

// ---- Driver --------------------------------------------------------------

function loadSectionFile(section: JaySection): JaySectionFile {
  const path = join(JAY_GOLDEN_SET, `${section}.json`)
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as JaySectionFile
}

type PlanItem = {
  section: JaySection
  jayKey: string
  scenario: JayScenario
  nnn: number
}

function buildPlan(): { plan: PlanItem[]; warnings: string[] } {
  const plan: PlanItem[] = []
  const warnings: string[] = []
  for (const section of TARGET_SECTIONS) {
    const file = loadSectionFile(section)
    const entries = Object.entries(file.scenarios).sort(([a], [b]) => a.localeCompare(b))
    let nnn = 1
    for (const [jayKey, scenario] of entries) {
      // Skip scenarios whose tool-set is entirely video/music/audio (drops to []
      // after mapping — those are video/music in disguise).
      const toolSet = new Set(
        scenario.turns.flatMap((t) => t.expected.tools ?? []),
      )
      const skippedToolsOnly = [...toolSet].every(
        (n) => n === 'generate_music' || n === 'generate_video' || n === 'text_to_speech',
      )
      if (toolSet.size > 0 && skippedToolsOnly) {
        warnings.push(`skip ${section}/${jayKey}: only video/music tools`)
        continue
      }
      plan.push({ section, jayKey, scenario, nnn })
      nnn += 1
    }
  }
  return { plan, warnings }
}

function validateOutputs(taskJson: unknown, fixtureJson: unknown | null): string[] {
  const errors: string[] = []
  const taskParse = AssistantTrajTaskSchema.safeParse(taskJson)
  if (!taskParse.success) {
    errors.push(`task schema: ${taskParse.error.message}`)
  }
  if (fixtureJson) {
    const fxParse = ToolFixtureFileSchema.safeParse(fixtureJson)
    if (!fxParse.success) errors.push(`fixture schema: ${fxParse.error.message}`)
  }
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const dryRun = args.includes('--dry-run') || !write

  const { plan, warnings } = buildPlan()
  console.log(
    `\n[migrate] plan: ${String(plan.length)} scenarios → AT-v3 tasks (dry-run=${String(dryRun)})`,
  )
  for (const w of warnings) console.log(`[migrate] warn: ${w}`)

  let okCount = 0
  let failCount = 0
  let needsBakeCount = 0
  const taskDir = join(AT_ROOT, 'tasks')
  const fxDir = join(AT_ROOT, 'tool_fixtures')

  for (const item of plan) {
    const converted = convertScenario(item.section, item.jayKey, item.scenario, item.nnn)
    const errs = validateOutputs(converted.taskJson, converted.fixtureJson)
    if (errs.length > 0) {
      console.log(`[migrate] FAIL ${item.section}/${item.jayKey}:`)
      for (const e of errs) console.log(`  ${e}`)
      failCount += 1
      continue
    }
    okCount += 1
    const task = converted.taskJson as { task_id: string }
    if (converted.fixtureJson) {
      const fx = converted.fixtureJson as { fixtures: { needs_bake?: boolean }[] }
      const bakeNeeded = fx.fixtures.some((f) => f.needs_bake === true)
      if (bakeNeeded) needsBakeCount += 1
    }
    if (write) {
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(
        join(taskDir, `${task.task_id}.json`),
        `${JSON.stringify(converted.taskJson, null, 2)}\n`,
        'utf-8',
      )
      if (converted.fixtureJson) {
        mkdirSync(fxDir, { recursive: true })
        writeFileSync(
          join(fxDir, `${task.task_id}.json`),
          `${JSON.stringify(converted.fixtureJson, null, 2)}\n`,
          'utf-8',
        )
      }
    }
  }

  console.log(
    `\n[migrate] done: ok=${String(okCount)} fail=${String(failCount)} needs_bake_tasks=${String(needsBakeCount)}`,
  )
  if (!write) {
    console.log(`[migrate] dry-run only — pass --write to persist.`)
  } else {
    console.log(`[migrate] wrote to ${taskDir} + ${fxDir}`)
  }
  // Existence cross-check on a few example files to surface path issues early.
  if (write && !existsSync(taskDir)) {
    console.error(`[migrate] ERROR: tasks dir missing after write: ${taskDir}`)
    process.exit(2)
  }
  if (failCount > 0) process.exit(1)
}

// Run only when invoked as a script (not when imported from a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

// Re-exports for unit tests.
export {
  TARGET_SECTIONS,
  SECTION_TO_CATEGORY,
  JAY_TOOL_TO_AT,
  buildTaskId,
  convertScenario,
  buildPlan,
}
