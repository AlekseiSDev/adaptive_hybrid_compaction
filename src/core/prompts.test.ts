import { describe, expect, test } from 'vitest'
import { buildSystemPrompt, DEFAULT_AGENT_SYSTEM_PROMPT } from './prompts.js'

describe('buildSystemPrompt', () => {
  test('no tools → no tools section emitted', () => {
    const p = buildSystemPrompt()
    expect(p).not.toContain('Available tools')
    expect(p).not.toContain('Tool usage policy')
    expect(p).toContain('You are an agent')
    expect(p).toContain('# Style')
    expect(p).toContain('# Refusal policy')
  })

  test('tools list → tools section + policy emitted', () => {
    const p = buildSystemPrompt({
      tools: [
        { name: 'fetch_url(url)', oneLiner: 'retrieve a webpage' },
        { name: 'google_search(query)', oneLiner: 'search the web' },
      ],
    })
    expect(p).toContain('# Available tools')
    expect(p).toContain('You have 2 tools')
    expect(p).toContain('**fetch_url(url)** — retrieve a webpage')
    expect(p).toContain('**google_search(query)** — search the web')
    expect(p).toContain('# Tool usage policy')
  })

  test('single tool → "1 tool" singular', () => {
    const p = buildSystemPrompt({
      tools: [{ name: 'recall(id)', oneLiner: 'fetch a stored item' }],
    })
    expect(p).toContain('You have 1 tool.')
  })

  test('benchContext → inserted after header, before tools/style', () => {
    const p = buildSystemPrompt({
      benchContext: 'You are a retail support agent.',
      tools: [{ name: 'get_order(id)', oneLiner: 'look up an order' }],
    })
    const headerIdx = p.indexOf('You are an agent')
    const ctxIdx = p.indexOf('You are a retail support agent.')
    const toolsIdx = p.indexOf('# Available tools')
    const styleIdx = p.indexOf('# Style')
    expect(headerIdx).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(toolsIdx)
    expect(toolsIdx).toBeLessThan(styleIdx)
  })

  test('empty benchContext is ignored', () => {
    const p1 = buildSystemPrompt({ benchContext: '   ' })
    const p2 = buildSystemPrompt({})
    expect(p1).toBe(p2)
  })

  test('DEFAULT_AGENT_SYSTEM_PROMPT is the no-tools no-context build', () => {
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).toBe(buildSystemPrompt())
    expect(DEFAULT_AGENT_SYSTEM_PROMPT).not.toContain('# Available tools')
  })
})
