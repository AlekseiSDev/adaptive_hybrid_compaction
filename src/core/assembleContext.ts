import type { Message, Observation, Tier1, Tier2, Tier3 } from './types.js'

export function renderObservationsAsNote(observations: readonly Observation[]): string {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp)
  const lines = ['## Observations from prior turns']
  sorted.forEach((obs, idx) => {
    lines.push(`- obs#${String(idx + 1)} ts=${String(obs.timestamp)} (${obs.confidence}) ${obs.statement}`)
    if (obs.subDetails) {
      for (const detail of obs.subDetails) {
        lines.push(`  - ${detail}`)
      }
    }
  })
  return lines.join('\n')
}

export function assembleContext(tier1: Tier1, tier2: Tier2, tier3: Tier3): Message[] {
  const out: Message[] = [tier1.systemPrompt, ...tier1.firstUserMessages]
  if (tier2.observations.length > 0) {
    out.push({
      role: 'system',
      content: [{ type: 'text', text: renderObservationsAsNote(tier2.observations) }],
    })
  }
  out.push(...tier3.recent)
  for (const inflight of tier3.inflight) {
    out.push(inflight.tool_use)
  }
  return out
}
