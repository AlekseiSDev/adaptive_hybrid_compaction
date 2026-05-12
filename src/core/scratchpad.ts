// Out-of-prompt store for offloaded atomic groups. MVP: in-memory Map.
// Per `decisions.md` 2026-05-13 (persistence policy), no SQLite/Postgres
// fallback at this layer. A5 may add TTL/eviction; A6 wires session boundary.

export type Scratchpad<T> = {
  put: (id: string, payload: T) => void
  get: (id: string) => T | null
  size: () => number
}

export function createInMemoryScratchpad<T>(): Scratchpad<T> {
  const store = new Map<string, T>()
  return {
    put: (id, payload) => {
      store.set(id, payload)
    },
    get: (id) => store.get(id) ?? null,
    size: () => store.size,
  }
}
