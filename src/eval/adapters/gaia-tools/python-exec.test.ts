import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pythonExec } from './python-exec.js'

describe('pythonExec', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ahc-gaia-py-'))
  })
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('captures stdout from simple print', async () => {
    const r = await pythonExec(workspaceDir, 'print("hi")')
    expect(r.stdout.trim()).toBe('hi')
    expect(r.exit_code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('captures stderr from raising exception', async () => {
    const r = await pythonExec(workspaceDir, 'raise ValueError("boom")')
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('ValueError')
  })

  it('returns exit_code from sys.exit', async () => {
    const r = await pythonExec(workspaceDir, 'import sys; sys.exit(7)')
    expect(r.exit_code).toBe(7)
  })

  it('does NOT leak API keys to subprocess env', async () => {
    process.env['LEAK_TEST_TAVILY_API_KEY'] = 'tvly-secret-leak'
    try {
      const code = 'import os; print(os.environ.get("LEAK_TEST_TAVILY_API_KEY", "absent"))'
      const r = await pythonExec(workspaceDir, code)
      expect(r.stdout.trim()).toBe('absent')
    } finally {
      Reflect.deleteProperty(process.env, 'LEAK_TEST_TAVILY_API_KEY')
    }
  })

  // Marked slow — verifies timeout fires. ~1.5s with short timeout.
  it('kills child on timeout, returns exit_code=-1 + TIMEOUT marker', async () => {
    const start = Date.now()
    const r = await pythonExec(workspaceDir, 'while True: pass', { timeoutMs: 800 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3000)
    expect(r.exit_code).toBe(-1)
    expect(r.stderr).toContain('TIMEOUT')
  }, 10_000)
})
