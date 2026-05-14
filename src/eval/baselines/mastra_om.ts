import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Agent } from '@mastra/core/agent'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import { DEFAULT_AGENT_SYSTEM_PROMPT } from '../../core/prompts.js'
import { costFromUsageWithCache, resolveActorModel } from '../llm.js'
import { composeTurnRecord } from '../telemetry.js'
import type {
  Baseline,
  BaselineState,
  Message,
  OpenRouterUsage,
  Task,
  TurnRecord,
} from '../types.js'

// MastraOMBaseline — main competitor per design/C_baselines.md §4.
// Library, not service: Mastra `Agent` + `Memory` (observationalMemory enabled
// by default) + `LibSQLStore` (embedded SQLite-class, per docs/investigations/
// mastra-storage.md — picked over PG testcontainers, no Docker dep).
//
// Per-task storage isolation: each task gets its own SQLite file under
// `./.mastra/c1_<task_id>.db`; thread_id within Mastra Memory keeps history
// addressable across step() calls; `finalize` cleans up the file.
//
// Real LLM wire — OpenRouter `gpt-5.4-mini` via Mastra's OpenAI-compatible
// model config. Mastra owns the provider call and does not propagate a $
// figure, but the AI SDK v6 `usage` shape it returns carries enough token
// counts (input/output/cached) to back-fill cost against OPENROUTER_PRICING.
// `cost_usd` is computed via `costFromUsageWithCache` in step(). Cache
// discount is applied per-model via `cache_read_factor` in the pricing table.

export type MastraOMDeps = {
  /** OpenRouter API key (or any OpenAI-compatible). */
  apiKey: string
  /**
   * Provider id + model id pair. Default — OpenRouter Gemini-3.1-Flash per
   * system_design.md §6.1.
   */
  providerId?: string
  modelId?: string
  /** Override OpenAI-compatible base URL. */
  url?: string
  /** Root dir for per-task SQLite files. Default `./.mastra/`. */
  storageRootDir?: string
  /**
   * System prompt / agent instructions. Default: `DEFAULT_AGENT_SYSTEM_PROMPT`
   * from core (shared with all other baselines for fair-comparison invariant).
   */
  systemPrompt?: string
}

const DEFAULT_PROVIDER_ID = 'openrouter'
// Per decisions.md 2026-05-13 pivot — supersedes gemini-3-flash-preview.
// gpt-5.4-mini fires OpenRouter auto-cache on stable system prompt prefix.
const DEFAULT_MODEL_ID = 'openai/gpt-5.4-mini'
const DEFAULT_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_STORAGE_ROOT = './.mastra'

type MastraScratch = {
  thread_id: string
  resource_id: string
  storage_path: string
  mastra_config: {
    model: string
    provider_id: string
    storage_kind: 'libsql'
    mastra_version: '1.32.1'
  }
}

function extractTextContent(msg: Message): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

function resolveMastraModel(deps: MastraOMDeps): {
  providerId: string
  modelId: string
  url: string
  apiKey: string
} {
  return {
    providerId: deps.providerId ?? DEFAULT_PROVIDER_ID,
    // H1: respect AHC_ACTOR_MODEL env override (shared with the other 3
    // default-model sites). Pre-H1 sweep of cross-model main set was
    // asymmetric — Mastra stayed on the hardcoded gpt-5.4-mini while ahc_core
    // + tau switched to Gemini.
    modelId: deps.modelId ?? resolveActorModel(DEFAULT_MODEL_ID),
    url: deps.url ?? DEFAULT_URL,
    apiKey: deps.apiKey,
  }
}

// Memory options carrying explicit OM model override. Without this, Mastra's
// OM falls back to hardcoded `google/gemini-2.5-flash` via Google direct API
// (looks up GOOGLE_GENERATIVE_AI_API_KEY env) — our project uses OpenRouter,
// so the silent fallback prevents OM from running at all. See investigation
// in docs/investigations/ + plan S13.
export function buildMemoryOptions(deps: MastraOMDeps): {
  observationalMemory: { model: ReturnType<typeof resolveMastraModel> }
} {
  return {
    observationalMemory: {
      model: resolveMastraModel(deps),
    },
  }
}

function buildAgent(
  deps: MastraOMDeps,
  storagePath: string,
): { agent: Agent; cleanup: () => Promise<void> } {
  const storage = new LibSQLStore({
    id: `c1_${storagePath}`,
    url: `file:${storagePath}`,
  })
  const memory = new Memory({
    storage,
    options: buildMemoryOptions(deps),
  })
  const agent = new Agent({
    id: 'ahc_c1_mastra_om',
    name: 'AHC C1 Mastra OM baseline',
    instructions: deps.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
    model: resolveMastraModel(deps),
    memory,
  })
  // Mastra agent holds storage refs through memory; cleanup = rm file after
  // finalize. Storage client itself doesn't expose .close() in the public
  // type surface — file removal is sufficient teardown for ephemeral tasks.
  const cleanup = async (): Promise<void> => {
    await rm(storagePath, { force: true })
  }
  return { agent, cleanup }
}

export function mastraOmBaseline(deps: MastraOMDeps): Baseline {
  const storageRoot = resolve(deps.storageRootDir ?? DEFAULT_STORAGE_ROOT)
  // Track per-task cleanup hooks keyed by task_id — `finalize()` looks them up.
  const cleanups = new Map<string, () => Promise<void>>()
  // Per-state Agent instances — keyed by storage_path so re-stepping a state
  // hits the same agent + memory thread. (BaselineState is plain data,
  // can't carry the Agent reference itself.)
  const agents = new Map<string, Agent>()

  return {
    name: 'mastra_om',
    prepare: (task: Task): BaselineState => {
      const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const storagePath = resolve(storageRoot, `c1_${safeTaskId}.db`)
      const thread_id = `mastra_${safeTaskId}`
      // Mastra Memory requires both threadId (conversation) and resourceId
      // (user/session). Per-task isolation → resource derived from same id.
      const resource_id = `ahc_resource_${safeTaskId}`
      const scratch: MastraScratch = {
        thread_id,
        resource_id,
        storage_path: storagePath,
        mastra_config: {
          model: `${deps.providerId ?? DEFAULT_PROVIDER_ID}/${deps.modelId ?? DEFAULT_MODEL_ID}`,
          provider_id: deps.providerId ?? DEFAULT_PROVIDER_ID,
          storage_kind: 'libsql',
          mastra_version: '1.32.1',
        },
      }
      return {
        task_id: task.id,
        history: [],
        scratch: { ...scratch },
      }
    },

    step: async (state, userMsg, _opts) => {
      const scratch = state.scratch as unknown as MastraScratch | undefined
      if (!scratch?.thread_id) {
        throw new Error('MastraOMBaseline.step: missing scratch.thread_id (call prepare first)')
      }

      // Lazy-init the agent (storage path lives in scratch). Reuse on
      // subsequent steps so Mastra Memory threads accumulate properly.
      let agent = agents.get(scratch.storage_path)
      if (!agent) {
        await mkdir(dirname(scratch.storage_path), { recursive: true })
        const built = buildAgent(deps, scratch.storage_path)
        agent = built.agent
        agents.set(scratch.storage_path, built.agent)
        cleanups.set(state.task_id, built.cleanup)
      }

      const userText = extractTextContent(userMsg)
      const turn_index = state.history.filter((m) => m.role === 'user').length

      const start = Date.now()
      const result = await agent.generate(
        [{ role: 'user', content: userText }],
        {
          memory: {
            thread: scratch.thread_id,
            resource: scratch.resource_id,
          },
          modelSettings: { temperature: 0 },
        },
      )
      const wall_clock_ms = Date.now() - start

      const responseText = result.text
      const responseMsg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
      }

      const usage = await Promise.resolve(result.usage)
      const telemetry: TurnRecord = composeTurnRecord(
        {
          turn_index,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          wall_clock_ms,
          ...(usage.cachedInputTokens !== undefined
            ? { cache_read_input_tokens: usage.cachedInputTokens }
            : {}),
          ...(usage.cacheCreationInputTokens !== undefined
            ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
            : {}),
        },
        {},
      )

      // Back-fill actor cost from token counts: Mastra owns the provider call
      // and does not report $ directly, but the AI SDK v6 usage shape gives us
      // enough to price the call against OPENROUTER_PRICING. Reshape into the
      // OpenRouterUsage form (`prompt_tokens` is total input including cached;
      // `cached_tokens` is the subset to apply cache_read_factor on).
      const resolvedModelId = deps.modelId ?? DEFAULT_MODEL_ID
      const usageForCost: OpenRouterUsage = {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined
          ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
          : {}),
      }
      const cost_usd = costFromUsageWithCache(resolvedModelId, usageForCost)

      return {
        response: responseMsg,
        state: {
          ...state,
          history: [...state.history, userMsg, responseMsg],
        },
        telemetry,
        cost_usd,
      }
    },

    finalize: async (state) => {
      const cleanup = cleanups.get(state.task_id)
      if (cleanup) {
        await cleanup()
        cleanups.delete(state.task_id)
      }
      const scratch = state.scratch as unknown as MastraScratch | undefined
      if (scratch?.storage_path) {
        agents.delete(scratch.storage_path)
      }
    },
  }
}
