// GAIA-med BenchAdapter + Grader. Per docs/design/K_gaia.md.
//
// Cross-domain agentic bench, n≈25 stratified (after attachment filter).
// Grader is pure-normalization exact-match (port of Holosophus
// `get_gaia_metrics.py:88-127`). No LLM-judge — per decisions.md 2026-05-22
// (Track K — gaia-med uses pure-normalization grader).
//
// Adapter `prepare()` returns single user-message with rendered GAIA prompt;
// tools wired by makeGaiaBenchRunner (K3) via runner-side dispatch.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BenchAdapter,
  Conversation,
  Grader,
  Message,
  RunnerResponse,
  Score,
  Task,
} from '../types.js'
import type { GaiaTask } from './gaia-med.schema.js'

export type { GaiaTask }

// Verbatim Holosophus `run_gaia.py:25-44` prompt. Templated via
// `renderGaiaPrompt(task)`; attached-files line dropped because Track K
// Medium scope filters tasks with attachments.
export const GAIA_DRIVER_SYSTEM =
  'You have one question to answer. It is paramount that you provide a correct answer.\n' +
  'Give it all you can: I know for a fact that you have access to all the relevant tools to solve it\n' +
  'and find the exact correct answer (the answer does exist).\n' +
  "Failure or 'I cannot answer' or 'None found' will not be tolerated, success will be rewarded.\n" +
  "Run verification steps if that's needed, you must make sure you find the correct answer!\n" +
  '\n' +
  "Return only the answer after the 'Final answer:'.\n" +
  "Don't provide any explanations after the 'Final answer:' line.\n" +
  'Answer the given question exactly as requested, read the question carefully.\n' +
  'For instance if are asked "how many thousand hours..." and the answer is 2000 hours, return "2" not "2000".\n' +
  "Don't include measurement units (like m³ or Å or %) in a numerical final answer."

export function renderGaiaPrompt(task: GaiaTask): string {
  return `Here is the question:\n===\n${task.question}\n===\n`
}

// --- Normalization helpers (port of get_gaia_metrics.py:88-127) ---

function isFloat(s: string): boolean {
  if (s.trim().length === 0) return false
  const v = Number.parseFloat(s)
  if (!Number.isFinite(v)) return false
  return /^[+-]?[\d.]+([eE][+-]?\d+)?$/.test(s.trim())
}

function normalizeNumberStr(s: string): number | null {
  const cleaned = s.replace(/[$,%]/g, '').trim()
  const v = Number.parseFloat(cleaned)
  return Number.isFinite(v) ? v : null
}

function normalizeStr(s: string): string {
  // Lowercase + strip whitespace + unicode punctuation. `\p{P}` covers
  // standard punctuation classes; combined with `\s` strips all spacing.
  return s.toLowerCase().replace(/[\s\p{P}]/gu, '')
}

function splitListString(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

/**
 * Pure-normalization exact-match scorer. Returns true iff
 * `modelAnswer` matches `groundTruth` after type-aware normalization.
 *
 * Three paths:
 *   1. Numeric — groundTruth parses as float → both sides normalized
 *      via stripping $,%, comma; numeric equality.
 *   2. List — groundTruth contains `,` or `;` → both sides split, element
 *      counts must match, per-element compared via path 1 if element parses
 *      as float, else path 3 (strict positional, not set-equality per
 *      design §3.4).
 *   3. Text — fall through; both sides lowercased + whitespace/punctuation
 *      stripped; string equality.
 */
export function answerScorer(modelAnswer: string, groundTruth: string): boolean {
  if (isFloat(groundTruth)) {
    const normalized = normalizeNumberStr(modelAnswer)
    if (normalized === null) return false
    return normalized === Number.parseFloat(groundTruth)
  }
  if (/[,;]/.test(groundTruth)) {
    const gtElems = splitListString(groundTruth)
    const maElems = splitListString(modelAnswer)
    if (gtElems.length !== maElems.length) return false
    for (let i = 0; i < gtElems.length; i += 1) {
      const gt = gtElems[i] ?? ''
      const ma = maElems[i] ?? ''
      if (isFloat(gt)) {
        const n = normalizeNumberStr(ma)
        if (n === null) return false
        if (n !== Number.parseFloat(gt)) return false
      } else {
        if (normalizeStr(ma) !== normalizeStr(gt)) return false
      }
    }
    return true
  }
  return normalizeStr(modelAnswer) === normalizeStr(groundTruth)
}

/**
 * Extract final answer from actor response. Tries (in order):
 *   1. "Final answer:**" (markdown bold form Holosophus sometimes emits)
 *   2. "Final answer:" (plain)
 *   3. Full text (fallback).
 *
 * Returns the trimmed segment after the last matching prefix.
 */
export function getFinalAnswer(text: string): string {
  const bold = text.split('Final answer:**')
  if (bold.length > 1) return (bold.at(-1) ?? '').trim()
  const plain = text.split('Final answer:')
  if (plain.length > 1) return (plain.at(-1) ?? '').trim()
  return text.trim()
}

// --- Adapter ---

function tasksDir(): string {
  return join(process.cwd(), 'benchmarks/gaia/tasks')
}

async function loadAllTaskFiles(): Promise<GaiaTask[]> {
  const dir = tasksDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const jsons = entries.filter((f) => f.endsWith('.json')).sort()
  const out: GaiaTask[] = []
  for (const f of jsons) {
    const raw = await readFile(join(dir, f), 'utf8')
    out.push(JSON.parse(raw) as GaiaTask)
  }
  return out
}

export const gaiaAdapter: BenchAdapter = {
  name: 'gaia-med',
  async loadTasks(_seed: number): Promise<Task[]> {
    const items = await loadAllTaskFiles()
    return items.map((item) => ({
      id: `gaia_${String(item.idx).padStart(3, '0')}`,
      input: item,
      expected: item.answer,
    }))
  },
  prepare(task: Task): Conversation {
    const item = task.input as GaiaTask
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: renderGaiaPrompt(item) }] },
    ]
    return { messages }
  },
}

// --- Grader (pure, sync wrapped in Promise) ---

/**
 * GAIA grader: extract "Final answer: X" from response text → normalize →
 * compare to task.expected. `judge_cost_usd: 0` always (no LLM call).
 *
 * `secondary` carries diagnostic context for post-hoc audit:
 *   - level: 1 | 2 | 3 (numeric for downstream per-level aggregation)
 *   - extracted_empty: 1 if response had no recoverable answer
 *   - n_steps / n_tool_calls: lifted from RunnerResponse.bench_extras
 *     (когда runner предоставляет — gaia_bench_agent + mastra-agent на
 *     gaia-med). Track K-tail diagnostic 2026-05-26 — нужно различать
 *     tool-call-zero (root cause A) от memory-balloon (root cause B).
 */
type GaiaBenchExtras = {
  n_steps?: number
  n_tool_calls?: number
}

export const gaiaGrader: Grader = {
  // Sync internally — wrapped in Promise to satisfy async Grader contract.
  // No LLM call, no `await` needed.
  score: (task: Task, response: RunnerResponse): Promise<Score> => {
    const item = task.input as GaiaTask
    const extras = (response.bench_extras as GaiaBenchExtras | undefined) ?? {}
    const diagSecondary: Record<string, number> = {
      level: Number.parseInt(item.level, 10),
    }
    if (extras.n_steps !== undefined) diagSecondary['n_steps'] = extras.n_steps
    if (extras.n_tool_calls !== undefined) {
      diagSecondary['n_tool_calls'] = extras.n_tool_calls
    }
    const extracted = getFinalAnswer(response.text)
    if (extracted.trim().length === 0) {
      return Promise.resolve({
        primary: 0,
        secondary: { ...diagSecondary, extracted_empty: 1 },
        judge_cost_usd: 0,
      })
    }
    const correct = answerScorer(extracted, item.answer)
    return Promise.resolve({
      primary: correct ? 1.0 : 0.0,
      secondary: diagSecondary,
      judge_cost_usd: 0,
    })
  },
}
