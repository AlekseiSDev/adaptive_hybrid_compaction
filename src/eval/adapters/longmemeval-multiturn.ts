// LongMemEval multi-turn replay BenchAdapter. Track H Phase 1 (2026-05-14).
//
// Why this exists: Phase D `longmemeval-med` adapter flattens all haystack
// sessions into ONE user message (history) + the question. With K_RECENT=6
// tierize and OBSERVER_THRESHOLD=8000, the entire haystack lands in Tier-3
// on turn 0 but gets immediately summarised on turn 1 if at all — observer
// fires 0 times across 240 sweep records (H6.5 audit).
//
// This adapter replays the SAME baked tasks differently: each haystack
// session becomes one user-turn (Mode A per H_ablations_and_TODOs §12.2)
// containing the formatted session text. Subsequent baseline.step() calls
// drive AHC's tier rotation: after K_RECENT turns, older sessions move
// from Tier-3 into Tier-2 via the observer (Task-Aware Extraction). With
// ~2.6K tok per session, Tier-3 sits at ~7.8K after 3 sessions — above
// the lme-multiturn sweep's OBSERVER_THRESHOLD=4000 override.
//
// Same baked task files (`benchmarks/longmemeval/tasks/lme_*.json`), same
// grader, same n=120 seed=42 subset — only the prepare() differs. F-report
// gets a single corpus drived through two shapes for "single-shot vs.
// incremental" comparison without re-baking.

import type {
  BenchAdapter,
  Conversation,
  Message,
  Task,
} from '../types.js'
import { longmemevalAdapter, type LongMemEvalTask } from './longmemeval-med.js'

// Formats one haystack session as readable text. Same shape as
// `flattenHistoryToText` per-session block in longmemeval-med.ts:60-68, but
// emitted as standalone user message rather than inside one mega-block.
export function formatSessionAsTurn(
  session: { role: string; content: string }[],
  sessionId: string,
  date: string | undefined,
): string {
  const parts: string[] = []
  parts.push(date && date.length > 0 ? `[${sessionId} | ${date}]` : `[${sessionId}]`)
  for (const msg of session) {
    parts.push(`${msg.role}: ${msg.content}`)
  }
  return parts.join('\n')
}

export function multiturnMessages(task: LongMemEvalTask): Message[] {
  const sessions = task.haystack_sessions
  const ids = task.haystack_session_ids ?? []
  const dates = task.haystack_dates ?? []
  const messages: Message[] = []
  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i] ?? []
    const sid = ids[i] ?? `session_${String(i + 1)}`
    const date = dates[i]
    const text = formatSessionAsTurn(session, sid, date)
    messages.push({ role: 'user', content: [{ type: 'text', text }] })
  }
  // Final user turn: the actual question.
  messages.push({ role: 'user', content: [{ type: 'text', text: task.question }] })
  return messages
}

export const longmemevalMultiturnAdapter: BenchAdapter = {
  name: 'lme-multiturn',
  // Reuse longmemevalAdapter.loadTasks so n=120 subset stays identical —
  // adapter selection in runner dispatch decides the shape, not the data.
  loadTasks: longmemevalAdapter.loadTasks,
  prepare(task: Task): Conversation {
    const item = task.input as LongMemEvalTask
    return { messages: multiturnMessages(item) }
  },
}
