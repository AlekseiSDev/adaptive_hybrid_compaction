import { describe, expect, test } from 'vitest'
import { anthropicCompactBaseline } from './anthropic_compact.js'
import type { Message, Task } from '../types.js'

// Real-Anthropic integration tests (skip-marked unless ANY of:
// ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN | CLAUDE_CODE_OAUTH_TOKEN).
// Phase-5 of live-tests plan — validates the dual-auth path against the
// real API. The file is SEPARATE from anthropic_compact.test.ts because the
// latter has a module-level `vi.mock('@anthropic-ai/sdk')`, which would
// otherwise stub out the network here too.

const ANTHROPIC_TOKEN =
  process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['CLAUDE_CODE_OAUTH_TOKEN']
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY']
const ANTHROPIC_LIVE =
  (ANTHROPIC_TOKEN !== undefined && ANTHROPIC_TOKEN.length > 0) ||
  (ANTHROPIC_API_KEY !== undefined && ANTHROPIC_API_KEY.length > 0)
const liveDescribe = ANTHROPIC_LIVE ? describe : describe.skip

const makeTask = (id: string): Task => ({ id, input: 'x', expected: 'y' })
const makeUser = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

function makeBaseline() {
  if (ANTHROPIC_TOKEN !== undefined && ANTHROPIC_TOKEN.length > 0) {
    return anthropicCompactBaseline({ authToken: ANTHROPIC_TOKEN })
  }
  return anthropicCompactBaseline({ apiKey: ANTHROPIC_API_KEY ?? '' })
}

liveDescribe('anthropicCompactBaseline.step — real Anthropic integration', () => {
  test(
    'three-turn pin-recall trajectory: history grows + response non-empty',
    async () => {
      const baseline = makeBaseline()
      let state = baseline.prepare(makeTask('live-ac-pin'))

      const r1 = await baseline.step(
        state,
        makeUser('Remember: my pin code is 4271. Just acknowledge it.'),
      )
      state = r1.state
      const r2 = await baseline.step(
        state,
        makeUser('Unrelated: what is 2 plus 2?'),
      )
      state = r2.state
      const r3 = await baseline.step(
        state,
        makeUser(
          'What pin code did I tell you earlier? Reply with just the digits.',
        ),
      )
      state = r3.state

      const text3 =
        r3.response.content.find((p) => p.type === 'text')?.text ?? ''
      expect(text3).toContain('4271')
      expect(state.history).toHaveLength(6)
      expect(r1.telemetry.input_tokens).toBeGreaterThan(0)
      expect(r1.telemetry.output_tokens).toBeGreaterThan(0)
    },
    90_000,
  )
})
