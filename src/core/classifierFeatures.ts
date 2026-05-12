import { byteLengthOfContent } from './tokenCounter.js'
import type { ClassifierFeatures, Message } from './types.js'

const RECENT_TURNS_WINDOW = 3

export function computeFeatures(history: readonly Message[]): ClassifierFeatures {
  let toolUsesTotal = 0
  let userMessages = 0
  let totalMessages = 0
  let multimodal = false
  let cumulativeBytes = 0
  let maxTurnIndex = -1

  const toolResultSizes: number[] = []
  const toolUsesPerTurn = new Map<number, number>()

  for (const message of history) {
    totalMessages++
    if (message.role === 'user') userMessages++
    if (message.metadata !== undefined) {
      if (message.metadata.turn_index > maxTurnIndex) maxTurnIndex = message.metadata.turn_index
    }
    cumulativeBytes += byteLengthOfContent(message.content)
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        toolUsesTotal++
        const turn = message.metadata?.turn_index ?? 0
        toolUsesPerTurn.set(turn, (toolUsesPerTurn.get(turn) ?? 0) + 1)
      } else if (part.type === 'tool_result') {
        toolResultSizes.push(byteLengthOfContent([part]))
      } else if (part.type === 'image' || part.type === 'file') {
        multimodal = true
      }
    }
  }

  const turnsTotal = maxTurnIndex >= 0 ? maxTurnIndex + 1 : 0

  const recentToolUses = (() => {
    if (turnsTotal === 0) return 0
    const firstRecentTurn = Math.max(0, turnsTotal - RECENT_TURNS_WINDOW)
    let count = 0
    for (let t = firstRecentTurn; t < turnsTotal; t++) {
      count += toolUsesPerTurn.get(t) ?? 0
    }
    return count
  })()

  const avgToolResultSize =
    toolResultSizes.length === 0
      ? 0
      : toolResultSizes.reduce((a, b) => a + b, 0) / toolResultSizes.length

  // Tokens-from-bytes proxy: 1 token ≈ 4 bytes (matches A2's charsOver4 heuristic).
  const cumulativeTokens = Math.ceil(cumulativeBytes / 4)

  return {
    tool_call_density: turnsTotal === 0 ? 0 : toolUsesTotal / turnsTotal,
    avg_tool_result_size: avgToolResultSize,
    recent_tool_density: recentToolUses / RECENT_TURNS_WINDOW,
    user_turn_ratio: totalMessages === 0 ? 0 : userMessages / totalMessages,
    multimodal_flag: multimodal,
    cumulative_tokens: cumulativeTokens,
    turns_total: turnsTotal,
  }
}
