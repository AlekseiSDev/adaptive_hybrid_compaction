// GAIA tools factory. Per docs/design/K_gaia.md §4.
//
// Builds AI SDK v6 `tool()` definitions over per-task `workspaceDir`
// (typically `/tmp/gaia-task-<uuid>/`, created by K3 runner). Each tool
// is a thin wrapper around its pure impl; tool errors propagate as
// thrown — AI SDK v6 surface them to the agent as tool_result errors.
//
// Schemas via `jsonSchema()` (NOT zod) per decisions.md 2026-05-13 D5
// (AI SDK v6 + zod 4 inference incompatible).

import { jsonSchema, tool, type ToolSet } from 'ai'
import type {
  AtomicGroup,
  ContentPart,
  EventEmitter,
  PointerPlaceholder,
  Scratchpad,
} from '../../../core/index.js'
import { describeImage } from './describe-image.js'
import { pythonExec } from './python-exec.js'
import { textEditor } from './text-editor.js'
import { visitWebpage } from './visit-webpage.js'
import { webSearch } from './web-search.js'

export { describeImage, pythonExec, textEditor, visitWebpage, webSearch }
export type { SearchResult } from './web-search.js'
export type { VisitWebpageResult } from './visit-webpage.js'
export type { TextEditorResult } from './text-editor.js'
export type { PythonExecResult } from './python-exec.js'
export type { DescribeImageResult } from './describe-image.js'

// K-tail-3 (2026-05-26): wires execute paths for recall_tool_summary and
// recall_tool_full when AHC is active. Without these handlers AI SDK has no
// way to dispatch the recall tool calls — it would emit a tool_call part and
// then fail with "missing execute". The middleware (ai-sdk-v6.ts) only
// publishes the tool schemas to the provider; execute resolution must come
// from the toolset passed to `generateText`.
export type GaiaRecallDeps = {
  scratchpad: Scratchpad<AtomicGroup>
  getPointers: () => readonly PointerPlaceholder[]
  // Optional core-event emitter — when present, recall execute fires a
  // RecallEvent so post-hoc audit and the probe script can see invocations.
  // Without this hook recall invocations are silent (only the tool_result
  // reaches the actor; nothing lands in the per-task events array).
  emit?: EventEmitter
}

function findToolResultOutput(group: AtomicGroup): unknown {
  const part = group.tool_result.content.find(
    (p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result',
  )
  return part?.output ?? null
}

/**
 * Build AI SDK v6 ToolSet for GAIA agent. `workspaceDir` is per-task tmpdir
 * passed by runner; tools that touch the filesystem (`text_editor`,
 * `python_exec`, `describe_image`) resolve relative paths against it.
 *
 * When `recallDeps` is supplied (AHC mode), two extra tools are added:
 * `recall_tool_summary` (looks up the pointer digest by recall_id) and
 * `recall_tool_full` (looks up the raw tool_result body in scratchpad).
 */
export function gaiaTools(
  workspaceDir: string,
  recallDeps?: GaiaRecallDeps,
): ToolSet {
  const base: ToolSet = {
    web_search: tool({
      description:
        'Search the web for information. Returns up to N results as {title, url, snippet} list.',
      inputSchema: jsonSchema<{ query: string; max_results?: number }>({
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      }),
      execute: ({ query, max_results }) =>
        webSearch(query, max_results === undefined ? {} : { maxResults: max_results }),
    }),

    visit_webpage: tool({
      description:
        'Fetch a webpage and extract readable text content (truncated to 50K chars). Returns {title, text_content}.',
      inputSchema: jsonSchema<{ url: string }>({
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      }),
      execute: ({ url }) => visitWebpage(url),
    }),

    text_editor: tool({
      description:
        'Read a local text file from the task workspace (read-only, max 100KB). Returns {content}.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
      execute: ({ path }) => textEditor(workspaceDir, path),
    }),

    python_exec: tool({
      description:
        'Execute Python code in a subprocess (30s timeout, restricted env). Returns {stdout, stderr, exit_code}.',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      }),
      execute: ({ code }) => pythonExec(workspaceDir, code),
    }),

    describe_image: tool({
      description:
        'Describe an image file from the task workspace via a vision model. Returns {description}.',
      inputSchema: jsonSchema<{ image_path: string; question: string }>({
        type: 'object',
        properties: {
          image_path: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['image_path', 'question'],
      }),
      execute: ({ image_path, question }) => describeImage(workspaceDir, image_path, question),
    }),
  }

  if (recallDeps === undefined) return base

  type RecallInput = { recall_id: string; reason: string }
  type RecallOutput =
    | {
        recall_id: string
        tool_name: string
        original_size_bytes?: number
        summary?: string
        output?: unknown
      }
    | { error: string; available_ids?: string[] }

  const recallSummary = tool<RecallInput, RecallOutput>({
    description:
      'Retrieve a content-aware summary of a previously offloaded tool result by recall_id. Cheap; try this first before recall_tool_full.',
    inputSchema: jsonSchema<{ recall_id: string; reason: string }>({
      type: 'object',
      properties: {
        recall_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['recall_id', 'reason'],
    }),
    execute: ({ recall_id, reason }) => {
      const pointers = recallDeps.getPointers()
      const pointer = pointers.find((p) => p.recall_id === recall_id)
      recallDeps.emit?.({
        kind: 'recall',
        recall_id,
        tool_name: 'recall_tool_summary',
        reason,
        turn_index: pointer?.turn_index ?? -1,
      })
      if (pointer === undefined) {
        return Promise.resolve({
          error: `unknown recall_id: ${recall_id}`,
          available_ids: pointers.map((p) => p.recall_id),
        })
      }
      return Promise.resolve({
        recall_id: pointer.recall_id,
        tool_name: pointer.tool_name,
        original_size_bytes: pointer.original_size_bytes,
        summary: pointer.digest,
      })
    },
  })

  const recallFull = tool<RecallInput, RecallOutput>({
    description:
      'Retrieve the raw full body of a previously offloaded tool result by recall_id. Use only if the summary from recall_tool_summary was insufficient.',
    inputSchema: jsonSchema<{ recall_id: string; reason: string }>({
      type: 'object',
      properties: {
        recall_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['recall_id', 'reason'],
    }),
    execute: ({ recall_id, reason }) => {
      const entry = recallDeps.scratchpad.get(recall_id)
      recallDeps.emit?.({
        kind: 'recall',
        recall_id,
        tool_name: 'recall_tool_full',
        reason,
        turn_index: entry?.turn_index ?? -1,
      })
      if (entry === null) {
        return Promise.resolve({
          error: `unknown recall_id: ${recall_id}`,
        })
      }
      return Promise.resolve({
        recall_id,
        tool_name: pointerToolName(entry),
        output: findToolResultOutput(entry),
      })
    },
  })

  // Merge as a fresh ToolSet — direct index assignment trips the
  // `FlexibleSchema<never>` index signature on ai's ToolSet type.
  return {
    ...base,
    recall_tool_summary: recallSummary,
    recall_tool_full: recallFull,
  }
}

function pointerToolName(group: AtomicGroup): string {
  const part = group.tool_use.content.find(
    (p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use',
  )
  return part?.name ?? '<unknown>'
}
