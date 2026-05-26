// `text_editor` tool for GAIA. Per docs/design/K_gaia.md §4.2.
//
// Read-only (Medium scope — no write/edit). Path-traversal guarded:
// resolved path must stay inside workspaceDir. 100KB cap.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type TextEditorResult = {
  content: string
  truncated?: boolean
  original_size?: number
}

const DEFAULT_MAX_BYTES = 100 * 1024

export async function textEditor(
  workspaceDir: string,
  inputPath: string,
  opts: { maxBytes?: number } = {},
): Promise<TextEditorResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const rootAbs = resolve(workspaceDir)
  const target = resolve(rootAbs, inputPath)
  // Path-traversal guard. Both endings normalized — sep matters on win, but
  // we're macOS/linux, so direct prefix check suffices.
  if (!target.startsWith(rootAbs + '/') && target !== rootAbs) {
    throw new Error(
      `text_editor: path "${inputPath}" escapes workspace ${workspaceDir}`,
    )
  }
  const raw = await readFile(target)
  if (raw.length > maxBytes) {
    return {
      content: raw.subarray(0, maxBytes).toString('utf8') +
        `\n\n[... truncated; original size ${String(raw.length)} bytes]`,
      truncated: true,
      original_size: raw.length,
    }
  }
  return { content: raw.toString('utf8') }
}
