import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bench, ConfigDef, RunMeta, RunRecord, RunSummary } from './types.js'

// Recursive sort-keys serializer so config_id is invariant under property-order
// permutations (smoke YAMLs and code paths assemble configs in different orders).
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify(undefined) returns undefined at runtime even though TS types it as string;
    // keep the defensive `?? 'null'`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  )
}

export function computeConfigId(config: ConfigDef): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex').slice(0, 16)
}

export function runDirFor(
  rootDir: string,
  bench: Bench,
  configId: string,
  seed: number,
): string {
  return join(rootDir, bench, configId, String(seed))
}

const RECORDS_FILE = 'records.ndjson'
const META_FILE = 'meta.json'
const SUMMARY_FILE = 'summary.json'

export async function appendRecord(runDir: string, record: RunRecord): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await appendFile(join(runDir, RECORDS_FILE), JSON.stringify(record) + '\n')
}

async function readNdjsonLines(runDir: string): Promise<unknown[]> {
  const path = join(runDir, RECORDS_FILE)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: unknown[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      console.error(`[persist] skipping malformed NDJSON line in ${path}`)
    }
  }
  return out
}

export async function readCompletedTaskIds(runDir: string): Promise<Set<string>> {
  const lines = await readNdjsonLines(runDir)
  const ids = new Set<string>()
  for (const line of lines) {
    const taskId = (line as { task_id?: unknown }).task_id
    if (typeof taskId === 'string') ids.add(taskId)
  }
  return ids
}

export async function readAllRecords(runDir: string): Promise<RunRecord[]> {
  return (await readNdjsonLines(runDir)) as RunRecord[]
}

export async function writeMeta(runDir: string, meta: RunMeta): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, META_FILE), JSON.stringify(meta, null, 2) + '\n')
}

export async function writeSummary(
  runDir: string,
  identity: { bench: Bench; config_id: string; seed: number },
  records: RunRecord[],
): Promise<void> {
  await mkdir(runDir, { recursive: true })
  const n_total = records.length
  const n_completed = records.length
  const mean_primary_score =
    n_completed === 0
      ? 0
      : records.reduce((acc, r) => acc + r.score.primary, 0) / n_completed
  const total_cost_usd = records.reduce((acc, r) => acc + r.cost_usd, 0)

  const summary: RunSummary = {
    bench: identity.bench,
    config_id: identity.config_id,
    seed: identity.seed,
    n_total,
    n_completed,
    mean_primary_score,
    total_cost_usd,
  }
  await writeFile(join(runDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + '\n')
}
