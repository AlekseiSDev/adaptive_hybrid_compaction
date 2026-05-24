import { describe, expect, test } from 'vitest'
import {
  AT_TOOL_NAMES,
  ToolFixtureFileSchema,
  type ToolFixtureFile,
} from './assistant-traj.tool-fixtures.schema.js'

const minimalFixture = {
  task_id: 'at_research_write_001',
  fixtures: [
    {
      tool_name: 'google_search',
      output_parts: [{ type: 'text', text: 'Top 3 results: ...' }],
    },
  ],
}

describe('ToolFixtureFileSchema — minimal contract', () => {
  test('parses minimal sidecar with one google_search fixture', () => {
    expect(() => ToolFixtureFileSchema.parse(minimalFixture)).not.toThrow()
  })

  test('rejects task_id outside at_<category>_<NNN> pattern', () => {
    const bad = { ...minimalFixture, task_id: 'random_id' }
    const result = ToolFixtureFileSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  test('rejects unknown tool_name (palette closure)', () => {
    const bad = {
      ...minimalFixture,
      fixtures: [
        {
          tool_name: 'fetch_url',
          output_parts: [{ type: 'text', text: 'x' }],
        },
      ],
    }
    const result = ToolFixtureFileSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  test('rejects empty fixtures array', () => {
    const bad = { ...minimalFixture, fixtures: [] }
    expect(() => ToolFixtureFileSchema.parse(bad)).toThrow()
  })

  test('rejects empty output_parts on a fixture', () => {
    const bad = {
      ...minimalFixture,
      fixtures: [{ tool_name: 'google_search', output_parts: [] }],
    }
    expect(() => ToolFixtureFileSchema.parse(bad)).toThrow()
  })
})

describe('ToolFixtureFileSchema — input_match variants', () => {
  test("input_match kind:'first' parses", () => {
    const ok = {
      ...minimalFixture,
      fixtures: [
        {
          ...minimalFixture.fixtures[0],
          input_match: { kind: 'first' },
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(ok)).not.toThrow()
  })

  test("input_match kind:'args_exact' parses with args", () => {
    const ok = {
      ...minimalFixture,
      fixtures: [
        {
          ...minimalFixture.fixtures[0],
          input_match: { kind: 'args_exact', args: { q: 'typescript 5.5' } },
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(ok)).not.toThrow()
  })

  test("input_match kind:'args_subset' parses with args", () => {
    const ok = {
      ...minimalFixture,
      fixtures: [
        {
          ...minimalFixture.fixtures[0],
          input_match: { kind: 'args_subset', args: { q: 'typescript' } },
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(ok)).not.toThrow()
  })

  test('input_match with unknown kind rejected', () => {
    const bad = {
      ...minimalFixture,
      fixtures: [
        {
          ...minimalFixture.fixtures[0],
          input_match: { kind: 'fuzzy', threshold: 0.8 },
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(bad)).toThrow()
  })
})

describe('ToolFixtureFileSchema — output_parts shapes', () => {
  test('image output part parses', () => {
    const ok = {
      ...minimalFixture,
      fixtures: [
        {
          tool_name: 'image_gen',
          output_parts: [
            { type: 'text', text: 'Generated image: https://example.com/x.png' },
            { type: 'image', path: 'tool_fixtures/at_image_qa_001/img_0.png' },
          ],
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(ok)).not.toThrow()
  })

  test('file output part parses (code_interpreter artefact)', () => {
    const ok = {
      ...minimalFixture,
      fixtures: [
        {
          tool_name: 'code_interpreter',
          output_parts: [
            { type: 'text', text: 'STDOUT:\nhi\n\nSTDERR:\n\nExit: 0' },
            { type: 'file', path: 'tool_fixtures/at_code_iter_001/out.csv', mime: 'text/csv' },
          ],
        },
      ],
    }
    expect(() => ToolFixtureFileSchema.parse(ok)).not.toThrow()
  })
})

describe('AT_TOOL_NAMES — palette closure', () => {
  test('exactly 4 tools', () => {
    expect(AT_TOOL_NAMES).toHaveLength(4)
  })

  test('contains image_gen, google_search, web_fetch, code_interpreter', () => {
    expect(AT_TOOL_NAMES).toEqual([
      'image_gen',
      'google_search',
      'web_fetch',
      'code_interpreter',
    ])
  })
})

describe('ToolFixtureFileSchema — type export', () => {
  test('ToolFixtureFile type is assignable from parsed value', () => {
    const parsed: ToolFixtureFile = ToolFixtureFileSchema.parse(minimalFixture)
    expect(parsed.task_id).toBe('at_research_write_001')
    expect(parsed.fixtures).toHaveLength(1)
  })
})
