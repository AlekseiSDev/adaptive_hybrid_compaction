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

/**
 * Build AI SDK v6 ToolSet for GAIA agent. `workspaceDir` is per-task tmpdir
 * passed by runner; tools that touch the filesystem (`text_editor`,
 * `python_exec`, `describe_image`) resolve relative paths against it.
 */
export function gaiaTools(workspaceDir: string): ToolSet {
  return {
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
}
