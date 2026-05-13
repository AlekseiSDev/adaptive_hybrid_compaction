// Tau-bench user-simulator. Per D5 plan Step 5.
//
// Simulates the customer side of a retail-support conversation. Wraps AI SDK v6
// `generateText` с GPT-4o-mini (default; cheap, fast). System prompt anchors
// the sim to the per-episode `instruction` and instructs to emit `##STOP##`
// when satisfied or stuck — that token serves as the episode-end signal in
// `agent-runner.ts`.

import type { LanguageModelV3 } from '@ai-sdk/provider'
import { generateText, type ModelMessage } from 'ai'
import { costFromUsage, OPENROUTER_PRICING } from '../../llm.js'

export const USER_SIM_DEFAULT_MODEL = 'openai/gpt-4o-mini'

export function userSimSystemPrompt(instruction: string): string {
  return (
    `You are simulating a CUSTOMER talking to a retail support agent.\n\n` +
    `Your goal / situation (you act as the customer with this background):\n` +
    `${instruction}\n\n` +
    `Rules:\n` +
    `- Stay in character as the customer. Don't reveal you are an AI.\n` +
    `- Provide info (email, name, zip, order_id, etc.) only when asked.\n` +
    `- Be concise (1-2 sentences per turn).\n` +
    `- When the agent has fully resolved your request OR you decide you've ` +
    `tried enough, say "##STOP##" as your very last token to end the call.`
  )
}

export type UserSimDeps = {
  model: LanguageModelV3
  modelId?: string // for cost lookup
}

export type UserSimResult = {
  text: string
  cost_usd: number
  done: boolean
}

export async function userSimStep(
  history: ModelMessage[],
  instruction: string,
  deps: UserSimDeps,
): Promise<UserSimResult> {
  const result = await generateText({
    model: deps.model,
    system: userSimSystemPrompt(instruction),
    messages: history,
  })
  const text = result.text.trim()
  const done = text.includes('##STOP##')
  // Project AI SDK usage onto OpenRouter pricing if we know the modelId.
  let cost_usd = 0
  const modelId = deps.modelId ?? USER_SIM_DEFAULT_MODEL
  if (Object.hasOwn(OPENROUTER_PRICING, modelId)) {
    cost_usd = costFromUsage(modelId, {
      prompt_tokens: result.usage.inputTokens ?? 0,
      completion_tokens: result.usage.outputTokens ?? 0,
    })
  }
  return { text, cost_usd, done }
}
