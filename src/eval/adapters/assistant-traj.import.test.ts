import { describe, expect, it } from 'vitest'
import {
  importJayCanvasScenario,
  type JayCanvasScenario,
} from './assistant-traj.import.js'
import { AssistantTrajTaskSchema } from './assistant-traj.schema.js'

const minimalConversational: JayCanvasScenario = {
  scenario: 'conversational_4',
  card_type: 'assistantOutput',
  model: 'claude-sonnet-4.6',
  payload_model: 'anthropic/claude-sonnet-4-6',
  captured_at: '2026-05-06T10:33:54.726Z',
  captured_git_commit: 'f65cf304c5',
  turns: [
    {
      user: 'нарисуй таблицу по схеме: название, где расположен, причины',
      expected: {
        tools: [],
        answer: 'Вот таблица...',
        answer_desc: 'Text-only answer: produced a table.',
      },
      datetime_reminder: 'Current date-time: Friday, 24 April 2026, 17:43',
    },
    {
      user: 'нужно больше информации',
      expected: {
        tools: [],
        answer: 'Расширяю таблицу...',
        answer_desc: 'Text-only refine.',
      },
    },
  ],
}

const codeIterWithTool: JayCanvasScenario = {
  scenario: 'cargo_loading_1',
  card_type: 'assistantOutput',
  model: 'claude-sonnet-4.6',
  payload_model: 'anthropic/claude-sonnet-4-6',
  captured_at: '2026-05-06T11:00:00.000Z',
  captured_git_commit: 'f65cf304c5',
  turns: [
    {
      user: 'запусти my_script.py и покажи вывод',
      expected: {
        tools: [{ name: 'run_python', input: { code: 'print(1+1)' } }],
        tool_outputs: { run_python: '2\n' },
        answer: 'Скрипт выполнен, результат: 2',
        answer_desc: 'Ran python tool, summarized.',
      },
    },
  ],
}

const conversationalWithImageUrl: JayCanvasScenario = {
  scenario: 'conversational_with_image',
  card_type: 'assistantOutput',
  model: 'gemini-3-flash',
  payload_model: 'openai/gemini-3-flash-preview',
  captured_at: '2026-05-06T12:00:00.000Z',
  captured_git_commit: 'f65cf304c5',
  turns: [
    {
      user: 'https://example.selstorage.ru/foo/diagram.svg визуализируй логику в Mermaid',
      expected: {
        tools: [],
        answer: 'Вот Mermaid-диаграмма...',
        answer_desc: 'Mermaid diagram.',
      },
    },
  ],
}

describe('importJayCanvasScenario', () => {
  it('imports a minimal text-only conversational scenario into a schema-valid AssistantTrajTask', () => {
    const { task, downloads } = importJayCanvasScenario(minimalConversational, {
      scenarioId: 'A1',
      sourceCategory: 'A',
      sourceFileBasename: 'A.json',
      taskId: 'at_mixed_001',
    })

    expect(() => AssistantTrajTaskSchema.parse(task)).not.toThrow()
    expect(task.task_id).toBe('at_mixed_001')
    expect(task.category).toBe('mixed')
    expect(task.source).toBe('opensource')
    expect(task.turns).toHaveLength(2)
    expect(task.turns[0]?.role).toBe('user')
    expect(task.turns[0]?.content).toContainEqual({
      type: 'text',
      text: minimalConversational.turns[0]?.user,
    })
    expect(task.tools_available).toEqual([])

    expect(task.evaluation).toMatchObject({
      strategy: 'llm_judge',
      rubric_id: 'mixed',
      expected_summary: 'Расширяю таблицу...',
    })

    expect(task.provenance.original_session_hash).toBe('A.json::A1')
    expect(downloads).toEqual([])
  })

  it('honours an explicit category override', () => {
    const { task } = importJayCanvasScenario(minimalConversational, {
      scenarioId: 'A1',
      sourceCategory: 'A',
      sourceFileBasename: 'A.json',
      taskId: 'at_research_write_007',
      category: 'research_write',
    })
    expect(task.category).toBe('research_write')
    expect(task.task_id).toBe('at_research_write_007')
    expect(task.evaluation).toMatchObject({ rubric_id: 'research_write' })
  })

  it('projects expected.tools[] into expected_tool_calls and tools_available[]', () => {
    const { task } = importJayCanvasScenario(codeIterWithTool, {
      scenarioId: 'CD1',
      sourceCategory: 'CD',
      sourceFileBasename: 'CD.json',
      taskId: 'at_code_iter_001',
    })

    expect(() => AssistantTrajTaskSchema.parse(task)).not.toThrow()
    expect(task.category).toBe('code_iter')
    expect(task.turns[0]?.expected_tool_calls).toEqual([
      { tool_name: 'run_python', required: true, args_match: 'semantic' },
    ])
    expect(task.tools_available.map((t) => t.name)).toEqual(['run_python'])
  })

  it('extracts inline image URLs into an image ContentPart + download marker', () => {
    const { task, downloads } = importJayCanvasScenario(conversationalWithImageUrl, {
      scenarioId: 'VG1',
      sourceCategory: 'VG',
      sourceFileBasename: 'VG.json',
      taskId: 'at_image_qa_001',
    })

    expect(() => AssistantTrajTaskSchema.parse(task)).not.toThrow()
    expect(task.category).toBe('image_qa')

    type ContentPartLike = { type: string; text?: string; path?: string }
    const firstTurnContent = (task.turns[0]?.content ?? []) as ContentPartLike[]

    const imageParts = firstTurnContent.filter((c) => c.type === 'image')
    expect(imageParts).toHaveLength(1)
    expect(imageParts[0]).toMatchObject({
      type: 'image',
      path: 'attachments/at_image_qa_001/1.svg',
    })

    const textParts = firstTurnContent.filter((c) => c.type === 'text')
    expect(textParts).toHaveLength(1)
    expect(textParts[0]?.text).not.toContain('selstorage.ru')
    expect(textParts[0]?.text).toContain('визуализируй')

    expect(downloads).toEqual([
      {
        url: 'https://example.selstorage.ru/foo/diagram.svg',
        targetPath: 'attachments/at_image_qa_001/1.svg',
      },
    ])
  })

  it('fails fast on an invalid task_id prefix vs category combination', () => {
    expect(() =>
      importJayCanvasScenario(minimalConversational, {
        scenarioId: 'A1',
        sourceCategory: 'A',
        sourceFileBasename: 'A.json',
        taskId: 'at_code_iter_999',
      }),
    ).toThrow(/task_id.*category/i)
  })
})
