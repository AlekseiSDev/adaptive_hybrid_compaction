import type { Tier1, Tier2 } from './types.js'

// Canonical JSON serialization with sorted object keys so the resulting bytes
// are independent of JS property insertion order. Used by §9.1 cache-invariance
// test (promoted from A1's JSON.stringify proxy to true bytewise check).
export function canonicalJSON(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null' // JSON.stringify drops undefined; we materialize it.
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(record[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export type CachePrefix = {
  tier1: Tier1
  tier2: Tier2
}

export function serializeForCache(prefix: CachePrefix): Buffer {
  return Buffer.from(canonicalJSON(prefix), 'utf8')
}
