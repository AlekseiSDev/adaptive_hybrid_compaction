import { describe, expect, test } from 'vitest'
import { OBSERVER_PROMPT_TEMPLATE, parseObservations } from './observerPrompt.js'

describe('OBSERVER_PROMPT_TEMPLATE', () => {
  test('contains the §4.2 instruction skeleton', () => {
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/factual/i)
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/high\|med\|low/)
  })

  test('frames observations as the ONLY persistent memory across turns', () => {
    // Mastra-style framing: the LLM has to understand stakes — anything not
    // captured here is forever lost. Without it the model produces lazy
    // abstractions and drops factual specifics.
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/only.+memory|memory.+only|forever lost|entirety/i)
  })

  test('explicitly demands preservation of numbers, names, and specifics', () => {
    // Direct cause of acc=0.200 on lme-multiturn n=10 was abstraction:
    // observer turned "user added 25 postcards" → "user discussed postcards".
    // Mastra's prompt sidesteps this by demanding specifics — borrowed wholesale.
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/numbers/i)
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/names|proper nouns/i)
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/preserve|verbatim/i)
  })

  test('shows BAD / GOOD examples to anchor the contrast', () => {
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/BAD/)
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/GOOD/)
  })

  test('instructs splitting multi-event messages into separate observation lines', () => {
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/split|separate observations/i)
  })

  test('output schema stays line-based — parseObservations must keep working', () => {
    // Format is `- timestamp (high|med|low) statement` + optional indented sub-detail.
    // Changing this breaks records.ndjson dump quality + downstream cache invariance.
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/- timestamp \(high\|med\|low\)/)
  })
})

describe('parseObservations', () => {
  test('parses canonical multi-observation output into Observation[]', () => {
    const raw = `- 1700000000 (high) user prefers TS strict mode
- 1700000050 (med) discussion centered on auth middleware`
    const obs = parseObservations(raw, 3)
    expect(obs).toHaveLength(2)
    expect(obs[0]).toEqual({
      timestamp: 1700000000,
      confidence: 'high',
      statement: 'user prefers TS strict mode',
      sourceTurn: 3,
    })
    expect(obs[1]?.confidence).toBe('med')
  })

  test('attaches sub-detail lines to parent observation', () => {
    const raw = `- 1700000000 (high) Found 3 docs matching auth middleware
  - doc_237 score 0.91, snippet about session cookie
  - doc_198 score 0.75
- 1700000050 (low) follow-up unclear`
    const obs = parseObservations(raw, 5)
    expect(obs).toHaveLength(2)
    expect(obs[0]?.subDetails).toEqual([
      'doc_237 score 0.91, snippet about session cookie',
      'doc_198 score 0.75',
    ])
    expect(obs[1]?.subDetails).toBeUndefined()
  })

  test('throws on unknown confidence string', () => {
    const raw = `- 1700000000 (bogus) something`
    expect(() => parseObservations(raw, 0)).toThrow(/confidence/)
  })

  test('empty input returns empty array', () => {
    expect(parseObservations('', 0)).toEqual([])
    expect(parseObservations('   \n\n  ', 0)).toEqual([])
  })
})
