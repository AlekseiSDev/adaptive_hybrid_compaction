import { describe, expect, test } from 'vitest'
import { AssistantTrajTaskSchema, type AssistantTrajTask } from './assistant-traj.schema.js'

const minimalValidImageQa = {
  task_id: 'at_image_qa_001',
  category: 'image_qa',
  source: 'opensource',
  turns: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', path: 'input_image.png' },
      ],
    },
  ],
  tools_available: [],
  evaluation: {
    strategy: 'llm_judge',
    rubric_id: 'image_qa',
    expected_summary: 'A red apple on a wooden table.',
  },
  provenance: {},
}

const compositeCodeIter = {
  task_id: 'at_code_iter_001',
  category: 'code_iter',
  source: 'real',
  turns: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Write a function that reverses a string.' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is the function...' }],
    },
  ],
  tools_available: [
    { name: 'run_python', description: 'Execute python', input_schema: { type: 'object' } },
  ],
  evaluation: {
    strategy: 'composite',
    aggregate: 'all',
    rules: [
      { strategy: 'regex', pattern: 'function\\s+\\w+\\(' },
      {
        strategy: 'llm_judge',
        rubric_id: 'code_iter',
        expected_summary: 'Correctly reverses string.',
      },
    ],
  },
  provenance: {
    anonymized_at: '2026-04-12',
    anonymization_steps: ['scrub_user_id', 'replace_paths'],
    review_signoff: 'AS 2026-04-13',
  },
}

describe('AssistantTrajTaskSchema — minimal contract', () => {
  test('parses minimal valid image_qa task', () => {
    expect(() => AssistantTrajTaskSchema.parse(minimalValidImageQa)).not.toThrow()
  })

  test('rejects task missing task_id', () => {
    const { task_id: _omit, ...rest } = minimalValidImageQa
    expect(() => AssistantTrajTaskSchema.parse(rest)).toThrow()
  })
})

describe('AssistantTrajTaskSchema — field-level invariants', () => {
  test('rejects category outside enum', () => {
    const bad = { ...minimalValidImageQa, category: 'not_a_category' }
    expect(() => AssistantTrajTaskSchema.parse(bad)).toThrow()
  })

  test('rejects unknown evaluation.strategy (discriminated union closure)', () => {
    const bad = { ...minimalValidImageQa, evaluation: { strategy: 'unknown' } }
    expect(() => AssistantTrajTaskSchema.parse(bad)).toThrow()
  })

  test('rejects task with empty turns array', () => {
    const bad = { ...minimalValidImageQa, turns: [] }
    expect(() => AssistantTrajTaskSchema.parse(bad)).toThrow()
  })

  test('rejects bad task_id format', () => {
    const bad = { ...minimalValidImageQa, task_id: 'image_qa_001' }
    expect(() => AssistantTrajTaskSchema.parse(bad)).toThrow(/task_id/)
  })
})

describe('AssistantTrajTaskSchema — cross-field invariants', () => {
  test("source='real' without provenance.anonymized_at fails", () => {
    const bad = { ...minimalValidImageQa, source: 'real' }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/anonymized_at/)
    }
  })

  test("source='real' with empty provenance.anonymized_at fails", () => {
    const bad = {
      ...minimalValidImageQa,
      source: 'real',
      provenance: { anonymized_at: '' },
    }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/anonymized_at/)
    }
  })

  test('task_id category prefix mismatching category field fails', () => {
    const bad = { ...minimalValidImageQa, task_id: 'at_code_iter_001' }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/category/)
    }
  })

  test('composite evaluation with empty rules fails', () => {
    const bad = {
      ...minimalValidImageQa,
      evaluation: { strategy: 'composite', aggregate: 'all', rules: [] },
    }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/at least one rule/)
    }
  })

  test('nested composite with empty inner rules fails', () => {
    const bad = {
      ...minimalValidImageQa,
      evaluation: {
        strategy: 'composite',
        aggregate: 'all',
        rules: [
          { strategy: 'regex', pattern: '.+' },
          { strategy: 'composite', aggregate: 'any', rules: [] },
        ],
      },
    }
    expect(() => AssistantTrajTaskSchema.parse(bad)).toThrow(/at least one rule/)
  })
})

// Track J1 — tool-grounded tasks. Cross-field rule: if any turn has
// expected_tool_calls with required:true, then tools_available must be non-empty
// AND every required tool_name must appear in tools_available[].name. See
// docs/design/J_at_tools.md §10.3.
describe('AssistantTrajTaskSchema — Track J tool-grounded cross-field rules', () => {
  const toolGroundedTask = {
    task_id: 'at_research_write_001',
    category: 'research_write',
    source: 'opensource',
    turns: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Find recent news on TypeScript 5.5 release.' }],
        expected_tool_calls: [{ tool_name: 'google_search', required: true }],
      },
    ],
    tools_available: [
      {
        name: 'google_search',
        description: 'Web search',
        input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ],
    evaluation: {
      strategy: 'llm_judge',
      rubric_id: 'research_write',
      expected_summary: 'Answers based on web search.',
    },
    provenance: {},
  }

  test('required tool present in tools_available → parses', () => {
    expect(() => AssistantTrajTaskSchema.parse(toolGroundedTask)).not.toThrow()
  })

  test('required:true with empty tools_available → rejects', () => {
    const bad = { ...toolGroundedTask, tools_available: [] }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/required tool/i)
    }
  })

  test('required tool_name not in tools_available[].name → rejects', () => {
    const bad = {
      ...toolGroundedTask,
      tools_available: [
        {
          name: 'web_fetch',
          description: 'Fetch a URL',
          input_schema: { type: 'object' },
        },
      ],
    }
    const result = AssistantTrajTaskSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toMatch(/google_search/)
    }
  })

  test('expected_tool_calls without required (or required:false) does NOT enforce palette match', () => {
    const ok = {
      ...toolGroundedTask,
      turns: [
        {
          ...toolGroundedTask.turns[0],
          expected_tool_calls: [{ tool_name: 'whatever_optional', required: false }],
        },
      ],
    }
    expect(() => AssistantTrajTaskSchema.parse(ok)).not.toThrow()
  })

  test('legacy AT-v1 task with empty expected_tool_calls + empty tools_available still parses', () => {
    expect(() => AssistantTrajTaskSchema.parse(minimalValidImageQa)).not.toThrow()
  })

  test('optional tool_fixtures_ref accepted', () => {
    const withRef = {
      ...toolGroundedTask,
      tool_fixtures_ref:
        'benchmarks/assistant_traj/tool_fixtures/at_research_write_001.json',
    }
    expect(() => AssistantTrajTaskSchema.parse(withRef)).not.toThrow()
  })
})

describe('AssistantTrajTaskSchema — round-trip identity', () => {
  test('JSON.stringify → JSON.parse → schema.parse for image_qa', () => {
    const json = JSON.stringify(minimalValidImageQa)
    const reparsed = AssistantTrajTaskSchema.parse(JSON.parse(json))
    expect(reparsed as unknown).toEqual(minimalValidImageQa)
  })

  test('JSON round-trip for composite code_iter (multi-turn + real provenance)', () => {
    const json = JSON.stringify(compositeCodeIter)
    const reparsed = AssistantTrajTaskSchema.parse(JSON.parse(json))
    expect(reparsed as unknown).toEqual(compositeCodeIter)
  })

  test('exported AssistantTrajTask type is assignable from parsed value', () => {
    const parsed: AssistantTrajTask = AssistantTrajTaskSchema.parse(minimalValidImageQa)
    expect(parsed.task_id).toBe('at_image_qa_001')
  })
})
