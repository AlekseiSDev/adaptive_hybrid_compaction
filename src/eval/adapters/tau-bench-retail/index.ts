// Tau-bench retail BenchAdapter + Grader + Runner factory. Per D5 plan Step 5.
//
// `tau-bench-retail-med` bench: live agentic loop с retail-tool execution +
// user-simulator, scored via `calculateReward(envState, expected_end_state)`.
// `bench_extras` side-channel carries env state + reward grader↔runner.
//
// Two Runner factories register here:
//   - `tau_bench_agent`     — vanilla actor, no AHC compaction
//   - `tau_bench_agent_ahc` — actor wrapped через AHC middleware
//                              (per D5 plan AHC integration в D5, not E1)

import { createOpenAI } from '@ai-sdk/openai'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FeatureFlags } from '../../../core/index.js'
import { createOpenRouterClient } from '../../llm.js'
import type {
  BenchAdapter,
  Conversation,
  Grader,
  RunnerContext,
  RunnerResponse,
  Score,
  Task,
  Runner,
} from '../../types.js'
import {
  runTauEpisode,
  TAU_ACTOR_DEFAULT_MODEL,
  TAU_USER_SIM_DEFAULT_MODEL,
  type EpisodeResult,
} from './agent-runner.js'
import type { Episode } from './types.js'

function tasksDir(): string {
  return join(process.cwd(), 'benchmarks/tau-bench/tasks')
}

function wikiPath(): string {
  return join(process.cwd(), 'benchmarks/tau-bench/wiki.md')
}

async function loadWiki(): Promise<string> {
  try {
    return await readFile(wikiPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'You are a retail support assistant.'
    }
    throw err
  }
}

export const taubenchAdapter: BenchAdapter = {
  name: 'tau-bench-retail-med',
  async loadTasks(_seed: number): Promise<Task[]> {
    let entries: string[]
    try {
      entries = await readdir(tasksDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: Task[] = []
    for (const f of entries.filter((x) => x.endsWith('.json')).sort()) {
      const raw = await readFile(join(tasksDir(), f), 'utf8')
      const episode = JSON.parse(raw) as Episode
      out.push({ id: episode.episode_id, input: episode, expected: episode.expected_end_state })
    }
    return out
  },
  prepare(_task: Task): Conversation {
    // Tau-bench Runner manages messages internally — the agent loop is не
    // «replay user turns» but live actor↔user-sim alternation seeded by
    // `episode.instruction`. prepare() returns an empty Conversation as
    // marker; the real seed lives в the Runner's call to runTauEpisode.
    return { messages: [] }
  },
}

export type TauBenchExtras = {
  reward: number
  envState: EpisodeResult['envState']
  n_steps: number
  n_tool_calls: number
}

export const taubenchGrader: Grader = {
  score: (_task: Task, response: RunnerResponse): Promise<Score> => {
    const extras = response.bench_extras as TauBenchExtras | undefined
    const reward = extras?.reward ?? 0
    return Promise.resolve({
      primary: reward,
      ...(extras !== undefined
        ? { secondary: { n_steps: extras.n_steps, n_tool_calls: extras.n_tool_calls } }
        : {}),
    })
  },
}

export type MakeTauBenchRunnerOpts = {
  apiKey: string
  baseURL?: string
  actorModelId?: string
  userSimModelId?: string
  ahcFlags?: Partial<FeatureFlags>
  maxSteps?: number
}

export function makeTauBenchRunner(opts: MakeTauBenchRunnerOpts): Runner {
  const baseURL = opts.baseURL ?? 'https://openrouter.ai/api/v1'
  const openai = createOpenAI({ apiKey: opts.apiKey, baseURL })
  const actorModelId = opts.actorModelId ?? TAU_ACTOR_DEFAULT_MODEL
  const userSimModelId = opts.userSimModelId ?? TAU_USER_SIM_DEFAULT_MODEL
  const actorModel = openai.chat(actorModelId)
  const userSimModel = openai.chat(userSimModelId)
  // AHC internal calls use OpenRouter for digest/observer/reflection — same
  // base provider, separate path from AI SDK (the LLMClient interface).
  const ahcInternalLlmClient = opts.ahcFlags
    ? createOpenRouterClient({ apiKey: opts.apiKey, appName: 'AHC' })
    : undefined

  const runnerName = opts.ahcFlags ? 'tau_bench_agent_ahc' : 'tau_bench_agent'

  return {
    name: runnerName,
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const episode = ctx.task.input as Episode
      const actorSystem = await loadWiki()
      const result = await runTauEpisode(episode, {
        actorModel,
        userSimModel,
        actorSystem,
        actorModelId,
        userSimModelId,
        ...(opts.ahcFlags !== undefined ? { ahcFlags: opts.ahcFlags } : {}),
        ...(ahcInternalLlmClient !== undefined ? { ahcInternalLlmClient } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(ctx.instrumentation !== undefined ? { emit: ctx.instrumentation } : {}),
      })
      return {
        text: result.finalText,
        turns: [],
        errors: result.errors.map((e) => ({
          turn_index: e.turn_index,
          kind: e.kind,
          message: e.message,
        })),
        totals: result.totals,
        cost_usd: result.cost_usd,
        bench_extras: {
          reward: result.reward,
          envState: result.envState,
          n_steps: result.n_steps,
          n_tool_calls: result.n_tool_calls,
        } satisfies TauBenchExtras,
      }
    },
  }
}
