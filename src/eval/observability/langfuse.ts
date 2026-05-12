import { type Tracer, trace } from '@opentelemetry/api'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

// Langfuse OTel pipeline. Env-gated per design/B_eval-harness.md §9.3:
// - LANGFUSE_ENABLED=true       → real provider + LangfuseSpanProcessor
// - LANGFUSE_ENABLED unset/false → noop tracer (NoopTracerProvider default)
//
// Package: @langfuse/otel@^5.3.0 (v5 SDK rewrite — supersedes deprecated
// langfuse-vercel; см. decisions.md 2026-05-13 B2 entries).

const TRACER_NAME = 'ahc-eval'
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com'

export type ObservabilityHandle = {
  enabled: boolean
  tracer: Tracer
  dispose: () => Promise<void>
}

export type SetupObservabilityOptions = {
  enabled?: boolean
  publicKey?: string
  secretKey?: string
  baseUrl?: string
}

function readBool(envVar: string | undefined): boolean {
  return envVar === 'true'
}

export function setupObservability(
  opts: SetupObservabilityOptions = {},
): ObservabilityHandle {
  const enabled = opts.enabled ?? readBool(process.env['LANGFUSE_ENABLED'])

  if (!enabled) {
    return {
      enabled: false,
      tracer: trace.getTracer(TRACER_NAME),
      dispose: () => Promise.resolve(),
    }
  }

  const publicKey = opts.publicKey ?? process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = opts.secretKey ?? process.env['LANGFUSE_SECRET_KEY']
  const baseUrl =
    opts.baseUrl ?? process.env['LANGFUSE_BASE_URL'] ?? DEFAULT_BASE_URL

  if (!publicKey || !secretKey) {
    throw new Error(
      'LANGFUSE_ENABLED=true but LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY env vars are missing',
    )
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
  })
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'ahc-eval' }),
    spanProcessors: [processor],
  })
  provider.register()

  return {
    enabled: true,
    tracer: provider.getTracer(TRACER_NAME),
    dispose: async () => {
      await provider.shutdown()
    },
  }
}
