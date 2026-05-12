import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setupObservability } from './langfuse.js'

beforeEach(() => {
  // Ensure clean env for every test (some tests stub LANGFUSE_*).
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('setupObservability — TDD seed #2: exporter no-op when disabled', () => {
  test('default (no LANGFUSE_ENABLED env) → enabled=false; span ops are noop; dispose resolves', async () => {
    vi.stubEnv('LANGFUSE_ENABLED', '')
    const obs = setupObservability()
    expect(obs.enabled).toBe(false)
    // Span lifecycle through the noop tracer must not throw.
    const span = obs.tracer.startSpan('test.span')
    span.setAttribute('x', 1)
    span.end()
    await expect(obs.dispose()).resolves.toBeUndefined()
  })

  test('LANGFUSE_ENABLED=false explicitly → enabled=false', () => {
    vi.stubEnv('LANGFUSE_ENABLED', 'false')
    const obs = setupObservability()
    expect(obs.enabled).toBe(false)
  })

  test('opts.enabled=false overrides env LANGFUSE_ENABLED=true', () => {
    vi.stubEnv('LANGFUSE_ENABLED', 'true')
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk')
    const obs = setupObservability({ enabled: false })
    expect(obs.enabled).toBe(false)
  })

  test('LANGFUSE_ENABLED=true but missing publicKey/secretKey → throws clear error', () => {
    vi.stubEnv('LANGFUSE_ENABLED', 'true')
    expect(() => setupObservability()).toThrow(/PUBLIC_KEY|SECRET_KEY/)
  })
})

describe('setupObservability — enabled path (light smoke)', () => {
  test('enabled=true with full config builds handle; tracer + dispose work', async () => {
    const obs = setupObservability({
      enabled: true,
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'http://localhost:3001',
    })
    expect(obs.enabled).toBe(true)
    // Just verify span lifecycle doesn't throw — we don't assert anything about
    // network egress (no real Langfuse here).
    const span = obs.tracer.startSpan('test.enabled')
    span.setAttribute('test', 'attr')
    span.end()
    await obs.dispose()
  })
})
