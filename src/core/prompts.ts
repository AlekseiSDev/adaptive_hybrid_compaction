// Default agentic system prompt builder. Content-only (no AI SDK dependency)
// so it lives in `src/core/` and is reused by both `src/ui/` (demo chat) and
// `src/eval/baselines/` (sweep actors) — fair-comparison invariant: AHC and
// all baselines see the same prompt for the same task.
//
// Tools are still defined via AI SDK code abstractions (parameter schemas,
// types, execute fns). The prose block here is *behavioral* guidance only —
// one-line "when to use" hints — not a duplication of the JSON schema.

export type ToolHint = {
  /** Display name shown in the prompt, e.g. `fetch_url(url)`. */
  name: string
  /** One-sentence "when to reach for this tool". */
  oneLiner: string
}

export type SystemPromptOptions = {
  /** Tool hints to surface. Omit / empty list → no tools section. */
  tools?: ToolHint[]
  /**
   * Optional bench / domain framing prepended after the agentic header.
   * Example: tau-bench retail wiki, or a UI-specific app description.
   */
  benchContext?: string
}

const AGENTIC_HEADER = `You are an agent working through a multi-turn conversation with persistent state. Each user turn may reference earlier turns, results from tools you called, or information you have already established. Your context may have been compacted by upstream middleware — assume earlier turns may be summarized; if you need exact details that are not visible, say so before guessing.`

const STYLE = `# Style

- Be concise: prefer 3–6 short sentences over essays. Use bullet lists when comparing items or summarising steps, not for plain prose.
- Match the user's language: Russian in, Russian out; English in, English out. Code, identifiers, URLs stay verbatim.
- Don't invent numbers, dates, names, or quotes. If you cannot ground a claim, say so.
- Don't pad with disclaimers ("I am an AI…", "as of my knowledge cutoff…"). The user knows.
- Ground factual claims in what you actually observed (tool output, user-provided context). Cite sources inline when applicable.`

const TOOL_USAGE_POLICY = `# Tool usage policy

- Do not call tools speculatively. If you can answer from context, do so — tools are billed and slow.
- Tools may fail; if a tool returns an error, surface the reason to the user in one sentence and ask how to proceed rather than silently retrying.
- For purely conversational turns ("how are you?", "what time format do you use?"), answer directly without tool calls.
- Chain tool calls when one result depends on another. Stop calling tools once you have enough to answer.`

const REFUSAL = `# Refusal policy

If a request is harmful (weapons, malware, targeted harassment, sexual content involving minors, defamation), refuse in one sentence and offer a benign reframe. Don't lecture. For ambiguous or dual-use requests, ask a clarifying question instead of refusing outright. Otherwise default to being helpful.`

function renderToolsBlock(tools: ToolHint[]): string {
  const lines = [
    '# Available tools',
    '',
    `You have ${String(tools.length)} tool${tools.length === 1 ? '' : 's'}. Schemas (parameters, types) are provided to you separately by the runtime — the list below is behavioral guidance for when to reach for each one.`,
    '',
    ...tools.map((t) => `- **${t.name}** — ${t.oneLiner}`),
  ]
  return lines.join('\n')
}

export function buildSystemPrompt(opts: SystemPromptOptions = {}): string {
  const parts: string[] = [AGENTIC_HEADER]
  if (opts.benchContext && opts.benchContext.trim().length > 0) {
    parts.push(opts.benchContext.trim())
  }
  if (opts.tools && opts.tools.length > 0) {
    parts.push(renderToolsBlock(opts.tools))
    parts.push(TOOL_USAGE_POLICY)
  }
  parts.push(STYLE, REFUSAL)
  return parts.join('\n\n')
}

/**
 * Default prompt for sweep actors operating in plain QA / text-bench mode
 * (no tools, no domain-specific framing). Used by AHC actor, full_context,
 * anthropic_compact, mastra_om for LME / LoCoMo / AT text-only tasks.
 *
 * Frozen at module load — same string across all baselines per task →
 * fair-comparison invariant holds.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT: string = buildSystemPrompt()
