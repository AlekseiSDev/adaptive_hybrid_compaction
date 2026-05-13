import { describe, expect, test } from 'vitest'
import { ahcCoreBaseline } from './runners/ahc_core.js'
import type { Message, Task } from './types.js'

// E3 cache-hit live smoke — verifies the Anthropic-direct provider path
// end-to-end against real Anthropic API. Validates that:
//   1. createAhcRuntime + @ai-sdk/anthropic wiring succeeds (auth, request
//      shape, response parsing).
//   2. The Anthropic usage object (cache_read_input_tokens /
//      cache_creation_input_tokens) flows through to TurnRecord.
//
// Note on caching: explicit cache hits (cache_read_input_tokens > 0 on
// 2nd turn) require the AHC middleware to emit `cache_control` markers on
// the stable Tier-1 prefix. That's separate from createAhcRuntime; the
// telemetry plumbing here is the prerequisite. When AHC middleware adds
// cache_control, this test will start observing > 0 without any update.
//
// Cost: ~$0.05 (1 task × 2 turns on claude-sonnet-4-6). Gated by
// ANTHROPIC_API_KEY env var so `verify.sh` stays green offline.

// Auth resolution mirrors makeAhcCoreRunner (runner.ts): prefer LITELLM
// forwarder when configured, fall back to direct ANTHROPIC_API_KEY. Test
// runs whenever at least one auth path is set.
const LITELLM_KEY = process.env['LITELLM_MASTER_KEY']
const LITELLM_URL = process.env['LITELLM_BASE_URL']
const HAS_LITELLM =
  LITELLM_KEY !== undefined &&
  LITELLM_KEY.length > 0 &&
  LITELLM_URL !== undefined &&
  LITELLM_URL.length > 0
const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY']
const HAS_DIRECT = ANTHROPIC_KEY !== undefined && ANTHROPIC_KEY.length > 0
const LIVE = HAS_LITELLM || HAS_DIRECT
const liveDescribe = LIVE ? describe : describe.skip

// LiteLLM proxy uses dot-form model aliases; direct API uses dash-form.
function resolveAuth(): { key: string; baseURL: string | undefined; model: string } {
  // TS narrows LITELLM_KEY / ANTHROPIC_KEY to `string` through HAS_LITELLM /
  // HAS_DIRECT const aliases (see definition above — `!== undefined && length > 0`).
  if (HAS_LITELLM) {
    return { key: LITELLM_KEY, baseURL: LITELLM_URL, model: 'claude-sonnet-4.6' }
  }
  if (HAS_DIRECT) {
    return { key: ANTHROPIC_KEY, baseURL: undefined, model: 'claude-sonnet-4-6' }
  }
  // unreachable when liveDescribe fires; satisfies TS exhaustiveness.
  return { key: '', baseURL: undefined, model: 'claude-sonnet-4-6' }
}
const RESOLVED = resolveAuth()

const makeTask = (id: string): Task => ({ id, input: 'x', expected: 'y' })
const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

liveDescribe(
  'E3 — ahcCoreBaseline.step × provider:anthropic_direct (Sonnet-4-6, live)',
  () => {
    test(
      'two-turn trajectory: response shape includes Anthropic cache_read field',
      async () => {
        const baseline = ahcCoreBaseline({
          apiKey: RESOLVED.key,
          provider: 'anthropic_direct',
          model: RESOLVED.model,
          ...(RESOLVED.baseURL !== undefined ? { baseURL: RESOLVED.baseURL } : {}),
        })
        let state = baseline.prepare(makeTask('e3-smoke-cache'))

        // Filler ensures the cached prefix (system + first user) exceeds
        // Anthropic's 1024-token minimum to activate ephemeral caching.
        const filler = 'a'.repeat(8000)
        const r1 = await baseline.step(
          state,
          makeUser('Context: ' + filler + '. Remember the magic word is "azure". Acknowledge briefly.'),
        )
        state = r1.state
        expect(r1.telemetry.input_tokens).toBeGreaterThan(1024)
        expect(r1.telemetry.output_tokens).toBeGreaterThan(0)

        const r2 = await baseline.step(
          state,
          makeUser('What was the magic word?'),
        )
        const text2 = r2.response.content.find((p) => p.type === 'text')?.text ?? ''
        expect(text2.toLowerCase()).toContain('azure')

        // S3 (E1): AHC middleware marks the first user message with
        // cache_control:ephemeral so the system + first user prefix is
        // cached server-side. On turn 2, that prefix is reused → cache_read
        // > 0. §2.1 target: cache_read_input_tokens / total_input_tokens
        // >= 60%; with system + filler-user pinned, observed ratio is ~99%.
        const cacheReadT2: number = r2.telemetry.cache_read_input_tokens ?? 0
        expect(cacheReadT2).toBeGreaterThan(0)
        const ratioT2 = cacheReadT2 / r2.telemetry.input_tokens
        expect(ratioT2).toBeGreaterThan(0.6)

        // Sanity: total cost recorded and non-negative.
        expect(r1.cost_usd).toBeGreaterThanOrEqual(0)
        expect(r2.cost_usd).toBeGreaterThanOrEqual(0)
        // Sonnet-4-6 is paid — cost should be > $0.0001 for 2 turns.
        expect(r1.cost_usd + r2.cost_usd).toBeGreaterThan(0.0001)
      },
      120_000,
    )
  },
)
