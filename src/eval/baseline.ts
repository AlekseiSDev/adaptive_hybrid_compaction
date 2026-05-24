import type {
  Baseline,
  BaselineStepOptions,
  ErrorRecord,
  Message,
  Runner,
  RunnerResponse,
  TokenUsage,
  TurnRecord,
} from './types.js'

function extractText(message: Message): string {
  for (const part of message.content) {
    if (part.type === 'text') return part.text
  }
  return ''
}

export function buildRunnerFromBaseline(baseline: Baseline): Runner {
  return {
    name: baseline.name,
    execute: async (conv, ctx) => {
      const turns: TurnRecord[] = []
      const errors: ErrorRecord[] = []
      let totalInput = 0
      let totalOutput = 0
      let totalCacheRead = 0
      let totalCacheCreate = 0
      let totalCost = 0
      let lastResponse: Message | null = null

      let state = baseline.prepare(ctx.task)
      const collectedToolCalls: { name: string; args: unknown }[] = []

      try {
        for (const msg of conv.messages) {
          if (msg.role !== 'user') continue
          try {
            const stepOpts: BaselineStepOptions = {}
            if (ctx.instrumentation) stepOpts.instrumentation = ctx.instrumentation
            if (conv.tools) stepOpts.tools = conv.tools
            const result = await baseline.step(state, msg, stepOpts)
            state = result.state
            turns.push(result.telemetry)
            lastResponse = result.response
            totalInput += result.telemetry.input_tokens
            totalOutput += result.telemetry.output_tokens
            totalCacheRead += result.telemetry.cache_read_input_tokens ?? 0
            totalCacheCreate += result.telemetry.cache_creation_input_tokens ?? 0
            totalCost += result.cost_usd
            if (result.toolCalls) collectedToolCalls.push(...result.toolCalls)
          } catch (err) {
            errors.push({
              turn_index: turns.length,
              kind: 'api_error',
              message: err instanceof Error ? err.message : String(err),
            })
            break
          }
        }
      } finally {
        if (baseline.finalize) {
          try {
            await baseline.finalize(state)
          } catch (err) {
            console.error(
              `[buildRunnerFromBaseline] finalize failed for baseline=${baseline.name}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
      }

      const totals: TokenUsage = {
        input: totalInput,
        output: totalOutput,
        ...(totalCacheRead > 0 ? { cache_read: totalCacheRead } : {}),
        ...(totalCacheCreate > 0 ? { cache_creation: totalCacheCreate } : {}),
      }

      const response: RunnerResponse = {
        text: lastResponse ? extractText(lastResponse) : '',
        turns,
        errors,
        totals,
        cost_usd: totalCost,
      }
      if (collectedToolCalls.length > 0) {
        response.toolCalls = collectedToolCalls
      }
      return response
    },
  }
}
