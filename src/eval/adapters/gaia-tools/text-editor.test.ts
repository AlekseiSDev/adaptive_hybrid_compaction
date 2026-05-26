import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { textEditor } from './text-editor.js'

describe('textEditor', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ahc-gaia-text-'))
  })
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('reads file content', async () => {
    writeFileSync(join(workspaceDir, 'hello.txt'), 'Hello, world!')
    const r = await textEditor(workspaceDir, 'hello.txt')
    expect(r.content).toBe('Hello, world!')
    expect(r.truncated).toBeUndefined()
  })

  it('reads file from nested subdirectory', async () => {
    mkdirSync(join(workspaceDir, 'sub'))
    writeFileSync(join(workspaceDir, 'sub/x.txt'), 'nested')
    const r = await textEditor(workspaceDir, 'sub/x.txt')
    expect(r.content).toBe('nested')
  })

  it('blocks path traversal via ..', async () => {
    writeFileSync(join(workspaceDir, 'a.txt'), 'inside')
    // Try to escape — should throw before file access.
    await expect(textEditor(workspaceDir, '../../../etc/passwd')).rejects.toThrow(
      /escapes workspace/,
    )
  })

  it('truncates files larger than maxBytes', async () => {
    const big = 'X'.repeat(200_000)
    writeFileSync(join(workspaceDir, 'big.txt'), big)
    const r = await textEditor(workspaceDir, 'big.txt', { maxBytes: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.original_size).toBe(200_000)
    expect(r.content.length).toBeLessThan(2000)
  })

  it('throws ENOENT for missing file', async () => {
    await expect(textEditor(workspaceDir, 'missing.txt')).rejects.toThrow()
  })
})
