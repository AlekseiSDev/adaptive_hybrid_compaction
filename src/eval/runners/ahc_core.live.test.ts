import { describe, expect, test } from 'vitest'
import { ahcCoreBaseline } from './ahc_core.js'
import type { Message, Task } from '../types.js'

// Real-OpenRouter integration tests for the ahc_core runner (AHC over
// AI SDK v6). Skip-marked when OPENROUTER_API_KEY is absent — `verify.sh`
// stays green offline.

const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY']
const LIVE = OPENROUTER_KEY !== undefined && OPENROUTER_KEY.length > 0
const liveDescribe = LIVE ? describe : describe.skip

const makeTask = (id: string): Task => ({ id, input: 'x', expected: 'y' })
const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

liveDescribe('ahcCoreBaseline.step — real OpenRouter + AI SDK + A6 middleware', () => {
  test(
    'three-turn pin-recall trajectory: seed fact → distractor → recall',
    async () => {
      const baseline = ahcCoreBaseline({
        apiKey: OPENROUTER_KEY ?? '',
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'google/gemini-3-flash-preview',
      })
      let state = baseline.prepare(makeTask('live-ahc-pin'))
      const r1 = await baseline.step(
        state,
        makeUser('Remember: my pin code is 4271. Just acknowledge.'),
      )
      state = r1.state
      const r2 = await baseline.step(state, makeUser('What is 2+2?'))
      state = r2.state
      const r3 = await baseline.step(
        state,
        makeUser('What pin code did I share earlier? Reply with just the digits.'),
      )
      state = r3.state

      const text3 = r3.response.content.find((p) => p.type === 'text')?.text ?? ''
      expect(text3).toContain('4271')
      // After 3 turns: 3 user + 3 assistant = 6 messages of history (state.history
      // excludes the system msg that the A6 middleware injects per call).
      expect(state.history).toHaveLength(6)
      // AI SDK usage propagates non-zero tokens.
      expect(r1.telemetry.input_tokens).toBeGreaterThan(0)
      expect(r1.telemetry.output_tokens).toBeGreaterThan(0)
      // Cost is non-negative (main + internal). Real cost depends on whether
      // AHC fired any compaction LLM calls — synthetic 3-turn flow likely
      // stays under thresholds, so internal cost may be 0.
      expect(r1.cost_usd).toBeGreaterThanOrEqual(0)
    },
    90_000,
  )
})
