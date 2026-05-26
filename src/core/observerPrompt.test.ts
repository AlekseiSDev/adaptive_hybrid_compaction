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
    // Format is `- YYYY-MM-DD (high|med|low) statement` + optional indented sub-detail.
    // Changing the surface format breaks records.ndjson dump quality + cache invariance.
    // ISO date chosen over integer epoch because real LLM output (Gemini-3.1-Flash
    // on lme-multiturn) naturally emits ISO — see decisions.md [2026-05-27] entry.
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/- YYYY-MM-DD \(high\|med\|low\)/)
  })

  test('forbids answering the user query (extraction-only, no refusal/answer-leak)', () => {
    // lme-mt killer task 01493427: observer LLM returned `25\n` (the answer) instead
    // of observations. Mitigation — explicit "do not answer" rule in prompt.
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/do not answer|do not respond|only observation/i)
  })

  test('shows a literal example at the very end for the LLM to mimic', () => {
    // Just an OUTPUT FORMAT line isn't enough — Mastra adds literal example
    // observations the LLM can pattern-match against. We did not do this in the
    // 2026-05-26 rewrite and lme-mt n=15 paid for it (parse-failure 8/12 fires).
    expect(OBSERVER_PROMPT_TEMPLATE).toMatch(/example/i)
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

  test('accepts ISO date YYYY-MM-DD as timestamp (real Gemini-3.1-Flash output shape)', () => {
    // 7 of 8 empty fires on n=3 lme-mt debug run came from LLM writing
    // `- 2023-11-30 (high) ...` — ISO date instead of integer epoch.
    // Parser must accept it without losing the observation.
    const raw = '- 2023-11-30 (high) user added 25 postcards to collection'
    const obs = parseObservations(raw, 12)
    expect(obs).toHaveLength(1)
    expect(obs[0]?.statement).toContain('25 postcards')
    expect(obs[0]?.confidence).toBe('high')
    // Timestamp stored as epoch seconds for symmetry with existing integer path.
    const expectedSeconds = Math.floor(Date.UTC(2023, 10, 30) / 1000)
    expect(obs[0]?.timestamp).toBe(expectedSeconds)
  })

  test('accepts slash-format date YYYY/MM/DD as timestamp', () => {
    // Empty fires #5 and #8: `- 2023/08/11 (high) ...` slash variant.
    // Same root cause; accepting both keeps the parser robust without a prompt re-tune.
    const raw = '- 2023/08/11 (med) user keeps old sneakers under bed'
    const obs = parseObservations(raw, 0)
    expect(obs).toHaveLength(1)
    expect(obs[0]?.timestamp).toBe(Math.floor(Date.UTC(2023, 7, 11) / 1000))
    expect(obs[0]?.statement).toContain('sneakers')
  })

  test('integer epoch timestamp still accepted (backward compat)', () => {
    // Existing observer.test.ts cases construct fixtures with `1700000000`.
    // The format drift fix must not regress the original path.
    const obs = parseObservations('- 1700000000 (high) old-format observation', 0)
    expect(obs).toHaveLength(1)
    expect(obs[0]?.timestamp).toBe(1700000000)
  })

  test('refusal-style output (single number, no bullet) returns []', () => {
    // Empty fire #1 (killer task 01493427): LLM wrote `25\n` — answered the user's
    // question instead of extracting. Parser should NOT magically rescue this;
    // returning [] is correct (the prompt-side anti-answer rule prevents it).
    const obs = parseObservations('25\n', 0)
    expect(obs).toEqual([])
  })
})
