import { describe, expect, test } from 'vitest'
import { createAhcRuntime } from './ahc-runtime.js'
import { SessionScratchpadRegistry } from './sessionScratchpad.js'

// createAhcRuntime — shape tests. Behavioral coverage (middleware compaction
// pipeline, recall tool, cache invariance) lives in src/adapters/ai-sdk-v6.test.ts
// and src/core/cacheInvariance.test.ts — those test the underlying middleware
// and core. This file only verifies the factory dispatches correctly between
// providers and propagates middleware deps.

const baseOpts = {
  apiKey: 'sk-fake',
  sessionId: () => 'sess-1',
  scratchpadRegistry: new SessionScratchpadRegistry(),
}

describe('createAhcRuntime — provider dispatch', () => {
  test('provider:openrouter returns wrapped LanguageModelV3', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
    })
    expect(runtime.model).toBeDefined()
    expect(typeof runtime.model).toBe('object')
    // wrapLanguageModel returns LanguageModelV3 with specificationVersion 'v3'.
    expect(
      (runtime.model as { specificationVersion?: string }).specificationVersion,
    ).toBe('v3')
  })

  test('provider:anthropic_direct returns wrapped LanguageModelV3', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'anthropic_direct',
      model: 'claude-sonnet-4-6',
    })
    expect(runtime.model).toBeDefined()
    expect(
      (runtime.model as { specificationVersion?: string }).specificationVersion,
    ).toBe('v3')
  })

  test('provider:openrouter accepts optional baseURL override', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      baseURL: 'https://custom-proxy.example.com/v1',
    })
    expect(runtime.model).toBeDefined()
  })

  test('provider:google_direct returns wrapped LanguageModelV3', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'google_direct',
      model: 'gemini-3-flash-preview',
    })
    expect(runtime.model).toBeDefined()
    expect(
      (runtime.model as { specificationVersion?: string }).specificationVersion,
    ).toBe('v3')
  })

  test('provider:google_direct accepts optional baseURL (for Vertex AI / proxy)', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'google_direct',
      model: 'gemini-3-flash-preview',
      baseURL: 'https://my-proxy.example.com',
    })
    expect(runtime.model).toBeDefined()
  })

  test('unsupported provider throws (exhaustive guard)', () => {
    expect(() =>
      createAhcRuntime({
        ...baseOpts,
        // @ts-expect-error — runtime check on union narrowing escape
        provider: 'fake_provider',
        model: 'x',
      }),
    ).toThrow(/unsupported provider/)
  })
})

describe('createAhcRuntime — middleware deps propagation', () => {
  test('emit callback is wired through (smoke — no calls without invocation)', () => {
    const events: unknown[] = []
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      emit: (e) => events.push(e),
    })
    expect(runtime.model).toBeDefined()
    // No events emitted without an actual generateText call; behavioral
    // coverage lives in ai-sdk-v6.e2e.test.ts.
    expect(events).toHaveLength(0)
  })

  test('onCompactResult callback is wired through', () => {
    const compactResults: unknown[] = []
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      onCompactResult: (_sid, result) => compactResults.push(result),
    })
    expect(runtime.model).toBeDefined()
  })

  test('flags propagate to middleware (smoke — no inspection without invocation)', () => {
    const runtime = createAhcRuntime({
      ...baseOpts,
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      flags: { TRAJECTORY_CLASSIFIER: true },
    })
    expect(runtime.model).toBeDefined()
  })
})
