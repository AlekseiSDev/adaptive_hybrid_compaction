#!/usr/bin/env tsx
// Track J4 — synthetic top-up generator for AT-v2 corpus.
//
// Fills the gap between J3 jay-canvas-derived task count and the n=50 target
// per J doc §5.1 distribution. Each task is a templated draft with placeholder
// fixture content; `source: 'synthetic'` and `provenance.review_signoff:
// '<draft>'` mark them for manual review before merge.
//
// J doc target: image_qa=8 / code_iter=14 / research_write=14 / mixed=14.
// Reads existing tasks/, computes gap per category, generates templated
// synthetics from a per-category prompt pool.

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssistantTrajCategory, AssistantTrajTask } from '../src/eval/adapters/assistant-traj.schema.js'
import { AssistantTrajTaskSchema } from '../src/eval/adapters/assistant-traj.schema.js'
import {
  AT_TOOL_NAMES,
  type AtToolName,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
} from '../src/eval/adapters/assistant-traj.tools.js'
import type { ToolFixtureFile } from '../src/eval/adapters/assistant-traj.tool-fixtures.schema.js'

const TARGET = {
  image_qa: 8,
  code_iter: 14,
  research_write: 14,
  mixed: 14,
} as const satisfies Record<AssistantTrajCategory, number>

function toolInputSchemaPlaceholder(name: AtToolName): unknown {
  void TOOL_INPUT_SCHEMAS[name]
  return {
    type: 'object',
    description: `${TOOL_DESCRIPTIONS[name]} (concrete shape: TOOL_INPUT_SCHEMAS.${name})`,
  }
}

// Per-category prompt templates. Each entry = (prompt, required_tools).
// Designed to exercise different facets of compaction stress:
//   - long tool result (web_fetch markdown, code stdout)
//   - multi-turn follow-up potential
//   - non-trivial tool args (passes through subset matcher)
type Template = {
  prompt: string
  tools: AtToolName[]
}

const CODE_ITER: Template[] = [
  { prompt: 'Run this Python and report the result: `print(sum(range(1,101)))`. Then add a function that returns the Nth triangular number and call it for N=10.', tools: ['code_interpreter'] },
  { prompt: 'Implement quicksort in Python and run it on `[3,1,4,1,5,9,2,6,5,3,5]`. Show the sorted output.', tools: ['code_interpreter'] },
  { prompt: 'Parse this CSV with pandas: `name,score\\nalice,90\\nbob,75\\ncarol,82`. Compute mean score and print rows above mean.', tools: ['code_interpreter'] },
  { prompt: 'Write a recursive function to compute the Fibonacci sequence up to F(15). Print all values.', tools: ['code_interpreter'] },
  { prompt: 'Given the polynomial p(x) = 2x^3 - 5x + 1, evaluate at x=2.5 and find its roots numerically using numpy.', tools: ['code_interpreter'] },
  { prompt: 'Read this JSON: `{"users":[{"id":1,"score":95},{"id":2,"score":72},{"id":3,"score":88}]}` and output a sorted descending list of users by score.', tools: ['code_interpreter'] },
  { prompt: 'Plot a sine wave from 0 to 2π with 100 points using matplotlib. Save to /tmp/sine.png and confirm.', tools: ['code_interpreter'] },
  { prompt: 'Write a unit test for this function: `def is_prime(n): return n > 1 and all(n%i for i in range(2,int(n**0.5)+1))`. Run it.', tools: ['code_interpreter'] },
  { prompt: 'Given matrix A=[[1,2],[3,4]] and B=[[5,6],[7,8]], compute A·B using numpy. Print result.', tools: ['code_interpreter'] },
  { prompt: 'Build a small SQLite in-memory DB with users(id,name,age), insert 5 rows, then SELECT all where age > 30.', tools: ['code_interpreter'] },
]

const RESEARCH_WRITE: Template[] = [
  { prompt: 'Find recent news on the TypeScript 5.5 release and summarize the top three changes.', tools: ['google_search'] },
  { prompt: 'Look up what the Pythia language model series is and summarize its training data composition.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Search for "AI SDK v6 release notes" and write a brief overview of the new middleware API.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'What does the WHATWG URL spec say about percent-encoded reserved characters? Cite the section.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Find documentation for the Vercel AI SDK `streamText` function and explain its key options.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Search for recent benchmark results comparing GPT-5 and Claude Opus 4 on code-generation tasks.', tools: ['google_search'] },
  { prompt: 'What is the Mastra framework and how does it compare to LangGraph? Summarize.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Look up the τ-bench retail benchmark — what tools does it ship and how is success measured?', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Find the OpenRouter documentation for prompt-cache pricing and summarize the cache_read multiplier.', tools: ['google_search', 'web_fetch'] },
]

const MIXED: Template[] = [
  { prompt: 'Find a public dataset of monthly average temperatures for Berlin (2020–2023) via google_search, fetch one source, then plot the trend with Python.', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Search for the SHA-256 spec, fetch the relevant RFC, then implement SHA-256 in pure Python and hash the string "hello".', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Generate an image of a vintage radio on a wooden desk, then write Python that uses Pillow to add a sepia filter (assume the image is loaded as `img`).', tools: ['image_gen', 'code_interpreter'] },
  { prompt: 'Find the Wikipedia article on the Fibonacci sequence, summarize Binet\'s formula, and verify F(20) using Python.', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Search recent news on EU AI Act implementation timelines, fetch one official source, summarize key 2026 obligations.', tools: ['google_search', 'web_fetch'] },
  { prompt: 'Find example code for matplotlib heatmaps, fetch the docs page, then plot a heatmap of a 5x5 random matrix.', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Generate an image of a futuristic library and write a 3-sentence description that could caption the image.', tools: ['image_gen'] },
  { prompt: 'Look up the WHATWG Fetch spec section on CORS, fetch the live spec, then write Python that demonstrates a simple CORS preflight check.', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Find the OpenAI Whisper paper, fetch the abstract, then write Python that loads a small audio file path and prints first 10 seconds duration.', tools: ['google_search', 'web_fetch', 'code_interpreter'] },
  { prompt: 'Generate an image of a watercolor lighthouse at sunset and provide a short artistic caption.', tools: ['image_gen'] },
]

const POOLS: Record<AssistantTrajCategory, Template[]> = {
  image_qa: [], // J3 filled all 8
  code_iter: CODE_ITER,
  research_write: RESEARCH_WRITE,
  mixed: MIXED,
}

async function existingPerCategory(tasksDir: string): Promise<Record<AssistantTrajCategory, number>> {
  const counts: Record<AssistantTrajCategory, number> = {
    image_qa: 0,
    code_iter: 0,
    research_write: 0,
    mixed: 0,
  }
  const files = await readdir(tasksDir)
  for (const f of files) {
    const m = /^at_(image_qa|code_iter|research_write|mixed)_\d{3}\.json$/.exec(f)
    if (m && m[1] !== undefined) {
      counts[m[1] as AssistantTrajCategory] += 1
    }
  }
  return counts
}

function placeholderFixture(taskId: string, tools: AtToolName[]): ToolFixtureFile {
  return {
    task_id: taskId,
    fixtures: tools.map((tool_name) => ({
      tool_name,
      output_parts: [
        {
          type: 'text',
          text: `<placeholder output for ${tool_name} — synthetic draft; replace via capture-at-fixture (J4 helper) or manual edit before merge>`,
        },
      ],
    })),
  }
}

function buildSyntheticTask(
  category: AssistantTrajCategory,
  index: number,
  template: Template,
): { task: AssistantTrajTask; fixture: ToolFixtureFile } {
  const taskId = `at_${category}_${String(index).padStart(3, '0')}`
  const task: AssistantTrajTask = {
    task_id: taskId,
    category,
    source: 'synthetic',
    turns: [
      {
        role: 'user',
        content: [{ type: 'text', text: template.prompt }],
        expected_tool_calls: template.tools.map((tool_name) => ({
          tool_name,
          required: true as const,
          args_match: 'subset' as const,
        })),
      },
    ],
    tools_available: template.tools.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      input_schema: toolInputSchemaPlaceholder(name),
    })),
    evaluation: {
      strategy: 'llm_judge',
      rubric_id: category,
      expected_summary: `Synthetic ${category} task — verify tool sequence and answer relevance.`,
    },
    provenance: {
      review_signoff: '<draft: synthetic top-up; needs manual review + fixture capture>',
    },
  }
  const validated = AssistantTrajTaskSchema.parse(task)
  return { task: validated, fixture: placeholderFixture(taskId, template.tools) }
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const tasksDir = join(repoRoot, 'benchmarks/assistant_traj/tasks')
  const fixturesDir = join(repoRoot, 'benchmarks/assistant_traj/tool_fixtures')
  await mkdir(tasksDir, { recursive: true })
  await mkdir(fixturesDir, { recursive: true })

  const existing = await existingPerCategory(tasksDir)
  console.log(`[J4] existing tasks: ${JSON.stringify(existing)}`)
  console.log(`[J4] target distribution: ${JSON.stringify(TARGET)}`)

  let totalWritten = 0
  for (const cat of ['image_qa', 'code_iter', 'research_write', 'mixed'] as const) {
    const gap = TARGET[cat] - existing[cat]
    if (gap <= 0) continue
    const pool = POOLS[cat]
    if (pool.length === 0) {
      console.log(`[J4] ${cat}: gap=${String(gap)} but no synthetic templates — skipping`)
      continue
    }
    if (pool.length < gap) {
      console.log(`[J4] ${cat}: gap=${String(gap)} but only ${String(pool.length)} templates — using all`)
    }
    let nextIdx = existing[cat] + 1
    const take = Math.min(gap, pool.length)
    for (let i = 0; i < take; i += 1) {
      const template = pool[i]
      if (!template) continue
      const { task, fixture } = buildSyntheticTask(cat, nextIdx, template)
      const taskPath = join(tasksDir, `${task.task_id}.json`)
      const fixturePath = join(fixturesDir, `${task.task_id}.json`)
      await writeFile(taskPath, JSON.stringify(task, null, 2) + '\n', 'utf8')
      await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', 'utf8')
      console.log(`[J4] ✓ ${task.task_id} (tools=${template.tools.join(',')})`)
      nextIdx += 1
      totalWritten += 1
    }
  }
  console.log(`\n[J4] wrote ${String(totalWritten)} synthetic drafts`)
  void AT_TOOL_NAMES
}

await main()
