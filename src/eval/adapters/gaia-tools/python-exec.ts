// `python_exec` tool for GAIA. Per docs/design/K_gaia.md §4.2.
//
// subprocess + 30s timeout + restricted env (only PATH passed). NOT
// Docker-sandboxed — explicit Medium-scope decision. CWD = workspaceDir
// (typically /tmp/gaia-task-<uuid>/ created per-task in K3 runner).
//
// Failure mode: timeout fires → child killed; result returned with
// `exit_code: -1`, `stderr: 'TIMEOUT'` (agent sees as tool_result, not
// exception).

import { spawn } from 'node:child_process'

export type PythonExecResult = {
  stdout: string
  stderr: string
  exit_code: number
}

export type PythonExecOptions = {
  timeoutMs?: number
  // Override Python binary (for tests that target a specific version).
  python?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_PYTHON = 'python3'
const MAX_OUTPUT_BYTES = 100 * 1024  // truncate stdout/stderr at 100KB

function captureCapped(buffer: string[], data: Buffer, total: { bytes: number }): void {
  const room = MAX_OUTPUT_BYTES - total.bytes
  if (room <= 0) return
  if (data.length <= room) {
    buffer.push(data.toString('utf8'))
    total.bytes += data.length
  } else {
    buffer.push(data.subarray(0, room).toString('utf8'))
    total.bytes = MAX_OUTPUT_BYTES
  }
}

export function pythonExec(
  workspaceDir: string,
  code: string,
  opts: PythonExecOptions = {},
): Promise<PythonExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const python = opts.python ?? DEFAULT_PYTHON

  return new Promise((resolvePromise) => {
    // Restricted env: ONLY PATH passes through. No API keys, no HF_TOKEN etc.
    // Minimal blast radius if actor tries arbitrary exfiltration.
    const env: NodeJS.ProcessEnv = {}
    if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH']

    const child = spawn(python, ['-c', code], {
      cwd: workspaceDir,
      env,
      timeout: timeoutMs,
    })

    const stdoutParts: string[] = []
    const stderrParts: string[] = []
    const stdoutTotal = { bytes: 0 }
    const stderrTotal = { bytes: 0 }
    let timedOut = false

    child.stdout.on('data', (d: Buffer) => {
      captureCapped(stdoutParts, d, stdoutTotal)
    })
    child.stderr.on('data', (d: Buffer) => {
      captureCapped(stderrParts, d, stderrTotal)
    })

    // Node sets `signal: 'SIGTERM'` and `code: null` on timeout. We treat
    // this as exit_code = -1 + stderr = 'TIMEOUT' so agent has a clear flag.
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' && code === null) timedOut = true
      const result: PythonExecResult = {
        stdout: stdoutParts.join(''),
        stderr: timedOut ? 'TIMEOUT\n' + stderrParts.join('') : stderrParts.join(''),
        exit_code: timedOut ? -1 : (code ?? -1),
      }
      resolvePromise(result)
    })

    child.on('error', (err) => {
      resolvePromise({
        stdout: '',
        stderr: `spawn error: ${err.message}`,
        exit_code: -1,
      })
    })
  })
}
