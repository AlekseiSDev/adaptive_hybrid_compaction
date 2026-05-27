// GAIA Anthropic /compact agent runner. Track K-tail-4 (2026-05-27).
//
// Mirrors mastra-agent-runner shape: single-shot agentic loop без user-sim,
// один initial user message с GAIA question → loop messages.create → tool_use
// dispatch → tool_result echo → until end_turn or maxSteps. Bypasses AI SDK
// (no @ai-sdk/anthropic) — native Anthropic SDK call shape required to forward
// `betas: ['compact-2026-01-12']` + `context_management` knobs that AI SDK
// provider plug может не пробрасывать корректно. Pattern matches the existing
// `anthropic_compact.ts` AT baseline (same beta + context_management invocation),
// но agentic loop вместо turn-by-turn step.
//
// Tool dispatch: direct calls в `webSearch` / `visitWebpage` / `textEditor` /
// `pythonExec` / `describeImage` exported by `gaia-tools/index.ts` (NOT через
// AI SDK ToolSet) — Anthropic SDK uses native `tool_use` blocks, не AI SDK's
// generateText abstraction. 5 tool schemas hardcoded as Anthropic-native
// `BetaToolUnion[]` (literal copies of gaiaTools schemas — duplication
// предпочтительна live-extraction из AI SDK's Schema abstraction для 5 tools).

import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaCompactionBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import type { Model as AnthropicModel } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anthropicCostFromUsageWithCache } from '../../llm.js'
import type { AnthropicUsage, InstrumentationEvent } from '../../types.js'
import {
  describeImage,
  pythonExec,
  textEditor,
  visitWebpage,
  webSearch,
} from '../gaia-tools/index.js'
import { renderGaiaPrompt, type GaiaTask } from '../gaia-med.js'

// Same step cap as Mastra / AHC variants — keeps cross-baseline n_steps
// comparison apples-to-apples.
const DEFAULT_MAX_STEPS = 40
const DEFAULT_MAX_TOKENS = 2048
// Mirror anthropic_compact.ts AT default. GAIA trajectories rarely cross 100K,
// so compaction в основном fire'ит только на heaviest tasks (PDF dumps,
// long search result chains) — это валидный сигнал «vendor's threshold под
// реальный input pattern».
const DEFAULT_TRIGGER_INPUT_TOKENS = 100_000

export const GAIA_ANTHROPIC_COMPACT_DEFAULT_MODEL: AnthropicModel = 'claude-haiku-4-5'

export type GaiaAnthropicCompactModel = AnthropicModel | (string & Record<never, never>)

export type RunGaiaTaskAnthropicCompactDeps = {
  apiKey: string
  baseURL?: string
  model?: GaiaAnthropicCompactModel
  actorSystem: string
  triggerInputTokens?: number
  maxSteps?: number
  maxTokens?: number
  workspaceDir?: string
  emit?: (e: InstrumentationEvent) => void
}

export type GaiaTaskResultAnthropicCompact = {
  finalText: string
  n_steps: number
  n_tool_calls: number
  n_compactions: number
  cost_usd: number
  totals: { input: number; output: number }
  events: InstrumentationEvent[]
  errors: { turn_index: number; kind: 'api_error'; message: string }[]
}

// Anthropic-native tool schemas — verbatim copies of gaiaTools (5 tools).
// Duplicated literally to avoid live-extraction из AI SDK Schema abstraction
// и async getter (`Schema.jsonSchema: PromiseLike<JSONSchema7>`). При расхождении
// gaiaTools authoritative — пересинхронизировать вручную.
const ANTHROPIC_GAIA_TOOLS: readonly BetaToolUnion[] = Object.freeze([
  {
    name: 'web_search',
    description:
      'Search the web for information. Returns up to N results as {title, url, snippet} list.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'visit_webpage',
    description:
      'Fetch a webpage and extract readable text content (truncated to 50K chars). Returns {title, text_content}.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'text_editor',
    description:
      'Read a local text file from the task workspace (read-only, max 100KB). Returns {content}.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'python_exec',
    description:
      'Execute Python code in a subprocess (30s timeout, restricted env). Returns {stdout, stderr, exit_code}.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'describe_image',
    description:
      'Describe an image file from the task workspace via a vision model. Returns {description}.',
    input_schema: {
      type: 'object',
      properties: {
        image_path: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['image_path', 'question'],
    },
  },
])

async function dispatchTool(
  workspaceDir: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  switch (name) {
    case 'web_search': {
      const args = (input ?? {}) as { query: string; max_results?: number }
      const opts =
        args.max_results === undefined ? {} : { maxResults: args.max_results }
      return webSearch(args.query, opts)
    }
    case 'visit_webpage': {
      const args = (input ?? {}) as { url: string }
      return visitWebpage(args.url)
    }
    case 'text_editor': {
      const args = (input ?? {}) as { path: string }
      return textEditor(workspaceDir, args.path)
    }
    case 'python_exec': {
      const args = (input ?? {}) as { code: string }
      return pythonExec(workspaceDir, args.code)
    }
    case 'describe_image': {
      const args = (input ?? {}) as { image_path: string; question: string }
      return describeImage(workspaceDir, args.image_path, args.question)
    }
    default:
      return { error: `unknown tool: ${name}` }
  }
}

export async function runGaiaTaskAnthropicCompact(
  task: GaiaTask,
  deps: RunGaiaTaskAnthropicCompactDeps,
): Promise<GaiaTaskResultAnthropicCompact> {
  const events: InstrumentationEvent[] = []
  const errors: GaiaTaskResultAnthropicCompact['errors'] = []

  const model = deps.model ?? GAIA_ANTHROPIC_COMPACT_DEFAULT_MODEL
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS
  const trigger = deps.triggerInputTokens ?? DEFAULT_TRIGGER_INPUT_TOKENS

  // Per-task workspace для filesystem tools — same pattern as agent-runner.ts.
  const workspaceDir =
    deps.workspaceDir ?? join(tmpdir(), `gaia-anthropic-${randomUUID()}`)
  const ownsWorkspace = deps.workspaceDir === undefined
  if (ownsWorkspace) await mkdir(workspaceDir, { recursive: true })

  const baseURLOpt = deps.baseURL !== undefined ? { baseURL: deps.baseURL } : {}
  const client = new Anthropic({ apiKey: deps.apiKey, ...baseURLOpt })

  // Agentic loop state
  const messages: BetaMessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: renderGaiaPrompt(task) } satisfies BetaTextBlockParam,
      ],
    },
  ]
  let compactionBlocks: BetaCompactionBlock[] = []

  let finalText = ''
  let stepsUsed = 0
  let toolCallsTotal = 0
  let compactionsTotal = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheCreation = 0
  let totalCost = 0

  try {
    for (let step = 0; step < maxSteps; step++) {
      // Build payload: compactionBlocks как synthetic user prefix + accumulated messages.
      // Mirror anthropic_compact.ts AT pattern (line 177-185).
      const payload: BetaMessageParam[] = []
      if (compactionBlocks.length > 0) {
        payload.push({
          role: 'user',
          content: compactionBlocks.map((b) => ({
            type: 'compaction' as const,
            content: b.content,
            encrypted_content: b.encrypted_content,
          })),
        })
      }
      for (const m of messages) payload.push(m)

      let response: BetaMessage
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          system: deps.actorSystem,
          messages: payload,
          tools: [...ANTHROPIC_GAIA_TOOLS],
          betas: ['compact-2026-01-12'],
          context_management: {
            edits: [
              {
                type: 'compact_20260112' as const,
                trigger: { type: 'input_tokens' as const, value: trigger },
              },
            ],
          },
        })
      } catch (err) {
        errors.push({
          turn_index: step,
          kind: 'api_error',
          message: `actor (gaia-anthropic): ${err instanceof Error ? err.message : String(err)}`,
        })
        throw err
      }

      stepsUsed += 1
      totalInput += response.usage.input_tokens
      totalOutput += response.usage.output_tokens
      if (response.usage.cache_read_input_tokens) {
        totalCacheRead += response.usage.cache_read_input_tokens
      }
      if (response.usage.cache_creation_input_tokens) {
        totalCacheCreation += response.usage.cache_creation_input_tokens
      }

      // Detect compaction blocks → accumulate (most recent supersedes prior).
      const newCompactionBlocks = response.content.filter(
        (b): b is BetaCompactionBlock => b.type === 'compaction',
      )
      if (newCompactionBlocks.length > 0) {
        compactionBlocks = newCompactionBlocks
        compactionsTotal += 1
        const compactedContentBytes = newCompactionBlocks.reduce(
          (sum, b) => sum + (b.content?.length ?? 0),
          0,
        )
        const event: InstrumentationEvent = {
          kind: 'compaction',
          payload: {
            type: 'reflection',
            turn_index: stepsUsed,
            before_bytes: 0,
            after_bytes: compactedContentBytes,
          },
        }
        events.push(event)
        deps.emit?.(event)
      }

      // Tool use → dispatch and continue
      const toolUseBlocks = response.content.filter(
        (b): b is BetaToolUseBlock => b.type === 'tool_use',
      )
      if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        // Append assistant turn — все content blocks кроме compaction (compaction
        // лежит отдельно в compactionBlocks).
        messages.push({
          role: 'assistant',
          content: response.content.filter((b) => b.type !== 'compaction'),
        })
        const toolResultContent: BetaMessageParam['content'] = []
        for (const block of toolUseBlocks) {
          toolCallsTotal += 1
          let resultText: string
          let isError = false
          try {
            const result = await dispatchTool(workspaceDir, block.name, block.input)
            resultText = typeof result === 'string' ? result : JSON.stringify(result)
          } catch (err) {
            resultText = err instanceof Error ? err.message : String(err)
            isError = true
          }
          toolResultContent.push({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: resultText,
            ...(isError ? { is_error: true } : {}),
          })
        }
        messages.push({ role: 'user', content: toolResultContent })
        continue
      }

      // end_turn → extract final text and break
      if (response.stop_reason === 'end_turn') {
        finalText = response.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        break
      }

      // max_tokens / other stop reasons — best-effort partial answer и выходим.
      finalText = response.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      break
    }

    const usage: AnthropicUsage = {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      ...(totalCacheRead > 0 ? { cache_read_input_tokens: totalCacheRead } : {}),
      ...(totalCacheCreation > 0
        ? { cache_creation_input_tokens: totalCacheCreation }
        : {}),
    }
    totalCost = anthropicCostFromUsageWithCache(model, usage)
  } catch {
    // Error already captured в errors[]. Swallow re-throw — partial result
    // matches mastra-agent-runner pattern.
  } finally {
    if (ownsWorkspace) {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  }

  return {
    finalText,
    n_steps: stepsUsed,
    n_tool_calls: toolCallsTotal,
    n_compactions: compactionsTotal,
    cost_usd: totalCost,
    totals: { input: totalInput, output: totalOutput },
    events,
    errors,
  }
}
