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

// MastraAgentBaseline — Track I baseline per design/I_mastra_agent.md.
// Sibling of mastra_om: same Mastra `Agent` + `Memory` + `LibSQLStore` chassis,
// but supports tool registration через `deps.tools` (empty для text-bench I1,
// populated retail-10 для tau I2). Multi-step agentic loop resolves
// inside `agent.generate()` when tools fire — на text-bench без tools это
// сводится к single-step generation, structurally ≈ mastra_om (см. design §2.2
// asymmetry). Fair-comparison invariant: shares DEFAULT_AGENT_SYSTEM_PROMPT.

export type MastraAgentDeps = {
  /** OpenRouter API key. */
  apiKey: string
  /** Provider id. Default `'openrouter'`. */
  providerId?: string
  /** Model id. Default — resolveActorModel('openai/gpt-5.4-mini'). */
  modelId?: string
  /** OpenAI-compatible base URL. Default OpenRouter v1. */
  url?: string
  /** Root dir для per-task SQLite файлов. Default `./.mastra/`. */
  storageRootDir?: string
  /** Agent instructions / system prompt. Default DEFAULT_AGENT_SYSTEM_PROMPT. */
  systemPrompt?: string
  /**
   * Pre-translated Mastra tools, keyed by name. Empty / undefined для text-bench
   * (I1 wiring готов для I2 reuse). When non-empty, forwarded to
   * `agent.generate(messages, {tools})` — Mastra's internal loop drives
   * tool_call → execute → tool_result alternation.
   *
   * Typed as Record<string, unknown> намеренно — Mastra tool type pin
   * финализируется в I2 investigation (см. docs/investigations/mastra-tools-api.md).
   */
  tools?: Record<string, unknown>
}

const DEFAULT_PROVIDER_ID = 'openrouter'
// Per decisions.md 2026-05-13 pivot — same default as mastra_om / full_context.
// gpt-5.4-mini fires OpenRouter auto-cache on stable system prompt prefix.
const DEFAULT_MODEL_ID = 'openai/gpt-5.4-mini'
const DEFAULT_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_STORAGE_ROOT = './.mastra'

type MastraAgentScratch = {
  thread_id: string
  resource_id: string
  storage_path: string
  mastra_agent_config: {
    model: string
    provider_id: string
    storage_kind: 'libsql'
    mastra_version: '1.32.1'
    tools_registered: string[]
  }
}

function extractTextContent(msg: Message): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

function resolveMastraModel(deps: MastraAgentDeps): {
  providerId: string
  modelId: string
  url: string
  apiKey: string
} {
  return {
    providerId: deps.providerId ?? DEFAULT_PROVIDER_ID,
    // H1 invariant: respect AHC_ACTOR_MODEL env override для cross-model
    // symmetry (mastra_om / full_context / ahc_core делают то же самое).
    modelId: deps.modelId ?? resolveActorModel(DEFAULT_MODEL_ID),
    url: deps.url ?? DEFAULT_URL,
    apiKey: deps.apiKey,
  }
}

// OM-model override — same fix as mastra_om.ts (S13 investigation). Without
// explicit observationalMemory.model, Mastra fallback'ит на hardcoded
// google/gemini-2.5-flash через GOOGLE_GENERATIVE_AI_API_KEY, что rebrаkes на
// our OpenRouter setup.
function buildMemoryOptions(deps: MastraAgentDeps): {
  observationalMemory: { model: ReturnType<typeof resolveMastraModel> }
} {
  return {
    observationalMemory: {
      model: resolveMastraModel(deps),
    },
  }
}

function buildAgent(
  deps: MastraAgentDeps,
  storagePath: string,
): { agent: Agent; cleanup: () => Promise<void> } {
  const storage = new LibSQLStore({
    id: `mastra_agent_${storagePath}`,
    url: `file:${storagePath}`,
  })
  const memory = new Memory({
    storage,
    options: buildMemoryOptions(deps),
  })
  const agent = new Agent({
    id: 'ahc_mastra_agent',
    name: 'AHC Mastra Agent baseline (Track I)',
    instructions: deps.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
    model: resolveMastraModel(deps),
    memory,
  })
  const cleanup = async (): Promise<void> => {
    await rm(storagePath, { force: true })
  }
  return { agent, cleanup }
}

export function mastraAgentBaseline(deps: MastraAgentDeps): Baseline {
  const storageRoot = resolve(deps.storageRootDir ?? DEFAULT_STORAGE_ROOT)
  const cleanups = new Map<string, () => Promise<void>>()
  // Per-state Agent instances keyed by storage_path. Mastra Agent holds memory
  // refs internally, so re-stepping a state must hit the same Agent instance.
  const agents = new Map<string, Agent>()

  const toolsRegistered = deps.tools ? Object.keys(deps.tools) : []

  return {
    name: 'mastra-agent',
    prepare: (task: Task): BaselineState => {
      const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const storagePath = resolve(
        storageRoot,
        `c1_mastra_agent_${safeTaskId}.db`,
      )
      const thread_id = `mastra_agent_${safeTaskId}`
      const resource_id = `ahc_resource_${safeTaskId}`
      const scratch: MastraAgentScratch = {
        thread_id,
        resource_id,
        storage_path: storagePath,
        mastra_agent_config: {
          model: `${deps.providerId ?? DEFAULT_PROVIDER_ID}/${
            deps.modelId ?? DEFAULT_MODEL_ID
          }`,
          provider_id: deps.providerId ?? DEFAULT_PROVIDER_ID,
          storage_kind: 'libsql',
          mastra_version: '1.32.1',
          tools_registered: [...toolsRegistered],
        },
      }
      return {
        task_id: task.id,
        history: [],
        scratch: { ...scratch },
      }
    },

    step: async (state, userMsg, _opts) => {
      const scratch = state.scratch as unknown as MastraAgentScratch | undefined
      if (!scratch?.thread_id) {
        throw new Error(
          'MastraAgentBaseline.step: missing scratch.thread_id (call prepare first)',
        )
      }

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

      // I1 text-bench shape — same call as mastra_om. Tools wiring (`deps.tools`)
      // is stored в scratch.mastra_agent_config.tools_registered для audit, но
      // НЕ передаётся в `agent.generate()` пока I2 investigation
      // (docs/investigations/mastra-tools-api.md) не пиннет точный shape Mastra
      // tools-API. После investigation: forward через constructor `new
      // Agent({tools})` ИЛИ через generate option — apied here.
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
      const scratch = state.scratch as unknown as MastraAgentScratch | undefined
      if (scratch?.storage_path) {
        agents.delete(scratch.storage_path)
      }
    },
  }
}

export { buildMemoryOptions }
