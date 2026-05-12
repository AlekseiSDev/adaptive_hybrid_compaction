// LLM injection contract. Core defines the interface; real providers (OpenRouter,
// Anthropic direct, …) implement and inject from the adapter layer (A6).
// When no caller is injected:
//  - A2 digest falls back to rule-based (§5.3 strategy 3).
//  - A3 observer becomes a no-op with a logged reason.

export type LLMMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LLMRequest = {
  messages: LLMMessage[]
  maxOutputTokens?: number
  temperature?: number
}

export type LLMResponse = {
  text: string
  // Provider-reported usage where available (kept neutral; adapters may add fields).
  usage?: {
    promptTokens?: number
    completionTokens?: number
  }
}

export type LLMCaller = (req: LLMRequest) => Promise<LLMResponse>
