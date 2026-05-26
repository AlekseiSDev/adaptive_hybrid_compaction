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
import { buildSystemPrompt } from '../../../core/prompts.js'
import { createOpenRouterClient } from '../../llm.js'
import type {
  BenchAdapter,
  Conversation,
  Grader,
  InstrumentationEvent,
  RunnerContext,
  RunnerResponse,
  Score,
  Task,
  TurnRecord,
  Runner,
} from '../../types.js'
import {
  runTauEpisode,
  TAU_ACTOR_DEFAULT_MODEL,
  TAU_USER_SIM_DEFAULT_MODEL,
  type EpisodeResult,
} from './agent-runner.js'
import { runTauEpisodeMastra } from './mastra-agent-runner.js'
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
  // E1: AHC_ACTOR_MODEL env var overrides defaults at runner construction.
  // Explicit opts.actorModelId still wins (sweep YAML / test path).
  const envActor = process.env['AHC_ACTOR_MODEL']
  const actorModelId =
    opts.actorModelId ??
    (envActor && envActor.length > 0 ? envActor : TAU_ACTOR_DEFAULT_MODEL)
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
      const wiki = await loadWiki()
      // Wrap retail wiki (tools + policies) with the standard agentic framing
      // (style, refusal, multi-turn awareness). Wiki itself enumerates tools
      // so no extra `tools:` hints needed — AI SDK schemas + wiki cover them.
      const actorSystem = buildSystemPrompt({ benchContext: wiki })
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
        ...(ctx.tracer !== undefined ? { tracer: ctx.tracer } : {}),
      })
      return {
        text: result.finalText,
        turns: buildEpisodeTurns(result.events),
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

export type MakeTauBenchMastraAgentRunnerOpts = {
  apiKey: string
  baseURL?: string
  actorModelId?: string
  userSimModelId?: string
  maxSteps?: number
}

// Track I (I2): `mastra-agent` baseline × tau-bench-retail-med dispatcher.
// Parallel to makeTauBenchRunner (vanilla / AHC) — separate factory keeps the
// AHC wiring path clean.
export function makeTauBenchMastraAgentRunner(
  opts: MakeTauBenchMastraAgentRunnerOpts,
): Runner {
  const baseURL = opts.baseURL ?? 'https://openrouter.ai/api/v1'
  const openai = createOpenAI({ apiKey: opts.apiKey, baseURL })
  const envActor = process.env['AHC_ACTOR_MODEL']
  const actorModelId =
    opts.actorModelId ??
    (envActor && envActor.length > 0 ? envActor : TAU_ACTOR_DEFAULT_MODEL)
  const userSimModelId = opts.userSimModelId ?? TAU_USER_SIM_DEFAULT_MODEL
  // user-sim runs через AI SDK provider (vanilla — matching tau_bench_agent).
  const userSimModel = openai.chat(userSimModelId)

  return {
    name: 'mastra-agent',
    async execute(_conv: Conversation, ctx: RunnerContext): Promise<RunnerResponse> {
      const episode = ctx.task.input as Episode
      const wiki = await loadWiki()
      const actorSystem = buildSystemPrompt({ benchContext: wiki })
      const result = await runTauEpisodeMastra(episode, {
        actorModel: {
          apiKey: opts.apiKey,
          providerId: 'openrouter',
          modelId: actorModelId,
          url: baseURL,
        },
        userSimModel,
        actorSystem,
        actorModelId,
        userSimModelId,
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(ctx.instrumentation !== undefined ? { emit: ctx.instrumentation } : {}),
        ...(ctx.tracer !== undefined ? { tracer: ctx.tracer } : {}),
      })
      return {
        text: result.finalText,
        turns: buildEpisodeTurns(result.events),
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

// Build TurnRecord skeletons keyed by turn_index seen in events. Events are
// later attached by runSweep via enrichTurnsWithEvents — that helper filters
// per turn_index, so a turn without a TurnRecord drops its events silently.
// tau-bench has no per-step token attribution (tokens aggregated at episode
// level via result.totals → RunRecord.totals), so individual TurnRecord
// token counts stay 0 — events flow into them, totals stay episode-level.
//
// Vanilla tau_bench_agent (no AHC) emits no compaction/recall events, so
// this returns []. AHC variant accumulates 1+ events per multi-turn episode
// → 1+ TurnRecords with attached compaction_events.
export function buildEpisodeTurns(events: readonly InstrumentationEvent[]): TurnRecord[] {
  const turnIndices = new Set<number>()
  for (const e of events) {
    if (e.kind === 'compaction' || e.kind === 'recall') {
      turnIndices.add(e.payload.turn_index)
    } else {
      turnIndices.add(e.turn_index)
    }
  }
  return [...turnIndices]
    .sort((a, b) => a - b)
    .map(
      (idx): TurnRecord => ({
        turn_index: idx,
        input_tokens: 0,
        output_tokens: 0,
        wall_clock_ms: 0,
        recall_events: [],
        compaction_events: [],
      }),
    )
}
