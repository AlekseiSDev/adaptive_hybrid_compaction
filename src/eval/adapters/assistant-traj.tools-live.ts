// J7 live tool wrappers — real provider calls behind AT_TOOL_MODE=live.
// Source of truth: docs/design/J_at_tools.md §3.3, §4.3, §4.4.
//
// Used only for bake-fixtures.ts (one-shot capture) and local debug. CI guard
// in tools.ts:resolveToolMode() forbids live mode under CI=true.
//
// Wrappers portированы (упрощённо, без NestJS DI) из:
//   - jay-canvas/apps/platform/api/src/functions/functions.google.ts (Gemini image)
//   - jay-canvas/apps/platform/api/src/functions/functions.brave.ts  (Brave search)
//   - jay-canvas/apps/platform/api/src/crawler/crawler.service.ts    (Firecrawl)
//   - jay-canvas/apps/platform/api/src/sandbox/sandbox.service.ts    (E2B)
//
// Optional deps (install when live mode actually needed):
//   pnpm add @mendable/firecrawl-js @e2b/code-interpreter
//
// @google/genai is already in dependencies (used by adapter ai-sdk-v6 + UI chat).

import type { AtToolName } from './assistant-traj.tool-fixtures.schema.js'
import type { ToolHandle, ToolHandleContentPart } from '../types.js'
import type { ToolResultPayload } from './assistant-traj.tools.js'
import {
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
} from './assistant-traj.tools.js'

// ---- Env resolution -------------------------------------------------------

type LiveEnv = {
  GOOGLE_GENAI_API_KEY: string
  BRAVE_API_KEY: string
  BRAVE_BASE_URL: string
  FIRECRAWL_API_KEY: string
  E2B_API_KEY: string
}

export class LiveToolEnvMissingError extends Error {
  readonly missingKeys: readonly string[]
  constructor(missingKeys: readonly string[]) {
    super(
      `AT_TOOL_MODE=live requires env: ${missingKeys.join(', ')}. ` +
        `Source values from jay-canvas/apps/platform/api/config/local.yaml.`,
    )
    this.name = 'LiveToolEnvMissingError'
    this.missingKeys = missingKeys
  }
}

const DEFAULTS: Partial<Record<keyof LiveEnv, string>> = {
  BRAVE_BASE_URL: 'https://brave-gw.just-ai.com',
}

function requireEnv<K extends keyof LiveEnv>(...keys: K[]): Pick<LiveEnv, K> {
  const missing: string[] = []
  const out: Partial<LiveEnv> = {}
  for (const key of keys) {
    const v = process.env[key] ?? DEFAULTS[key]
    if (!v) missing.push(key)
    else out[key] = v
  }
  if (missing.length > 0) throw new LiveToolEnvMissingError(missing)
  return out as Pick<LiveEnv, K>
}

// ---- image_gen / image_edit (Gemini) --------------------------------------

const GEMINI_MODELS = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'nano-banana-3-pro': 'gemini-3-pro-image-preview',
} as const
type NanoBananaModel = keyof typeof GEMINI_MODELS

const DEFAULT_GEMINI_MODEL = GEMINI_MODELS['nano-banana-2']

async function geminiClient() {
  const env = requireEnv('GOOGLE_GENAI_API_KEY')
  const { GoogleGenAI } = await import('@google/genai')
  return new GoogleGenAI({ apiKey: env.GOOGLE_GENAI_API_KEY })
}

type GeminiImageArgs = {
  prompt: string
  images?: string[] | undefined
  size?: string | undefined
  modelName?: NanoBananaModel | undefined
}

async function fetchAsInlineImage(url: string): Promise<
  | { inlineData: { data: string; mimeType: string } }
  | { error: string }
> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { error: `${String(res.status)} ${res.statusText}` }
    const buf = Buffer.from(await res.arrayBuffer())
    return { inlineData: { data: buf.toString('base64'), mimeType: 'image/png' } }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function callGeminiImage(args: GeminiImageArgs): Promise<{
  imageData: Buffer
  caption: string
}> {
  const client = await geminiClient()
  const model = args.modelName
    ? GEMINI_MODELS[args.modelName]
    : DEFAULT_GEMINI_MODEL
  const parts: unknown[] = [{ text: args.prompt }]
  for (const url of (args.images ?? []).slice(0, 3)) {
    const part = await fetchAsInlineImage(url)
    if ('inlineData' in part) parts.push(part)
  }
  // @google/genai v2 surface: client.models.generateContent
  const response = await (client as unknown as {
    models: { generateContent: (req: unknown) => Promise<unknown> }
  }).models.generateContent({
    model,
    contents: parts,
    config: { responseModalities: ['IMAGE'] },
  })

  const cand = (
    response as {
      candidates?: { content?: { parts?: { inlineData?: { data: string } }[] } }[]
      promptFeedback?: { blockReason?: string }
    }
  ).candidates?.[0]
  const block = (response as { promptFeedback?: { blockReason?: string } }).promptFeedback
    ?.blockReason
  if (block) throw new Error(`gemini block: ${block}`)
  const part = cand?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part?.inlineData?.data) throw new Error('gemini returned no image data')
  return {
    imageData: Buffer.from(part.inlineData.data, 'base64'),
    caption: args.prompt.slice(0, 120),
  }
}

// ---- google_search (Brave) ------------------------------------------------

type BraveSearchArgs = { q: string; n?: number; lang?: string; country?: string }

async function callBraveSearch(args: BraveSearchArgs): Promise<
  { title: string; snippet: string; url: string }[]
> {
  const env = requireEnv('BRAVE_API_KEY', 'BRAVE_BASE_URL')
  const url = new URL(`${env.BRAVE_BASE_URL}/res/v1/web/search`)
  url.searchParams.set('q', args.q.trim())
  if (args.country) url.searchParams.set('country', args.country)
  if (args.lang) url.searchParams.set('search_lang', args.lang)
  const res = await fetch(url.toString(), {
    headers: { 'X-Subscription-Token': env.BRAVE_API_KEY, Accept: '*/*' },
  })
  if (!res.ok) throw new Error(`brave search ${String(res.status)}: ${res.statusText}`)
  const data = (await res.json()) as {
    web?: { results?: { title: string; description: string; url: string }[] }
  }
  const limit = args.n ?? 5
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    snippet: r.description,
    url: r.url,
  }))
}

// ---- web_fetch (Firecrawl) ------------------------------------------------

type WebFetchArgs = { url: string; max_chars?: number }

async function callFirecrawl(args: WebFetchArgs): Promise<{
  title: string
  markdown: string
}> {
  const env = requireEnv('FIRECRAWL_API_KEY')
  const { default: FirecrawlApp } = (await import('@mendable/firecrawl-js')) as unknown as {
    default: new (opts: { apiKey: string }) => {
      scrapeUrl: (
        url: string,
        opts: unknown,
      ) => Promise<{
        success: boolean
        markdown?: string
        metadata?: { title?: string }
        error?: string
      }>
    }
  }
  const client = new FirecrawlApp({ apiKey: env.FIRECRAWL_API_KEY })
  const res = await client.scrapeUrl(args.url, {
    timeout: 10_000,
    onlyMainContent: true,
    excludeTags: ['form'],
    formats: ['markdown'],
  })
  if (!res.success) throw new Error(`firecrawl: ${res.error ?? 'unknown error'}`)
  const max = args.max_chars ?? 8000
  const md = (res.markdown ?? '').slice(0, max)
  return { title: res.metadata?.title ?? '', markdown: md }
}

// ---- code_interpreter (E2B) -----------------------------------------------

type CodeInterpreterArgs = { code: string; timeout_ms?: number }

async function callE2B(args: CodeInterpreterArgs): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const env = requireEnv('E2B_API_KEY')
  const { Sandbox } = (await import('@e2b/code-interpreter')) as unknown as {
    Sandbox: {
      create: (opts: { apiKey: string }) => Promise<{
        runCode: (code: string, opts?: { timeoutMs?: number }) => Promise<{
          logs: { stdout: string[]; stderr: string[] }
          error?: { name?: string; value?: string } | null
        }>
        kill: () => Promise<void>
      }>
    }
  }
  const sbx = await Sandbox.create({ apiKey: env.E2B_API_KEY })
  try {
    const exec = await sbx.runCode(args.code, { timeoutMs: args.timeout_ms ?? 15_000 })
    return {
      stdout: exec.logs.stdout.join(''),
      stderr: exec.logs.stderr.join(''),
      exitCode: exec.error ? 1 : 0,
    }
  } finally {
    // Swallow kill errors — sandbox lifecycle is best-effort during bake.
    await sbx.kill().catch((e: unknown) => {
      console.warn(`[e2b] kill warning: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}

// ---- ToolHandle factories (live-bound) ------------------------------------

// Each handle: validate input via Zod (same schema as replay), dispatch to the
// live provider, then format output to match the deterministic shapes documented
// in J §3.2. The fixture-capture path (bake-fixtures.ts) serialises these into
// `tool_fixtures/<task_id>.json` so replay can mimic bit-for-bit later.

export type LiveHandle = ToolHandle & {
  // Bake-side hook — captures binary attachments produced by the call so
  // bake-fixtures.ts can persist them under attachments/<task_id>/.
  attachments?: () => readonly { suggestedName: string; bytes: Buffer; mime: string }[]
}

function textPart(text: string): ToolHandleContentPart {
  return { type: 'text', text }
}

export function buildLiveTools(): Record<AtToolName, LiveHandle> {
  const out = {} as Record<AtToolName, LiveHandle>

  out.image_gen = {
    description: TOOL_DESCRIPTIONS.image_gen,
    inputSchema: TOOL_INPUT_SCHEMAS.image_gen,
    execute: async (input: unknown): Promise<ToolResultPayload> => {
      const args = TOOL_INPUT_SCHEMAS.image_gen.parse(input) as GeminiImageArgs
      const r = await callGeminiImage(args)
      const text = `Generated image: <inline>\nCaption: ${r.caption}`
      out.image_gen.attachments = () => [
        { suggestedName: `img.png`, bytes: r.imageData, mime: 'image/png' },
      ]
      return { content: [textPart(text)] }
    },
  }

  out.image_edit = {
    description: TOOL_DESCRIPTIONS.image_edit,
    inputSchema: TOOL_INPUT_SCHEMAS.image_edit,
    execute: async (input: unknown): Promise<ToolResultPayload> => {
      const raw = TOOL_INPUT_SCHEMAS.image_edit.parse(input) as {
        image_url: string
        instruction: string
        size?: string
      }
      const r = await callGeminiImage({
        prompt: raw.instruction,
        images: [raw.image_url],
        size: raw.size,
      })
      const text = `Edited image: <inline>\nCaption: ${r.caption}\nSource: ${raw.image_url}`
      out.image_edit.attachments = () => [
        { suggestedName: `img_edited.png`, bytes: r.imageData, mime: 'image/png' },
      ]
      return { content: [textPart(text)] }
    },
  }

  out.google_search = {
    description: TOOL_DESCRIPTIONS.google_search,
    inputSchema: TOOL_INPUT_SCHEMAS.google_search,
    execute: async (input: unknown): Promise<ToolResultPayload> => {
      const args = TOOL_INPUT_SCHEMAS.google_search.parse(input) as BraveSearchArgs
      const results = await callBraveSearch(args)
      const lines = results
        .map((r, i) => `${String(i + 1)}. ${r.title} — ${r.snippet}\n   ${r.url}`)
        .join('\n')
      const text =
        results.length === 0
          ? `No results for "${args.q}".`
          : `Top ${String(results.length)} results:\n${lines}`
      return { content: [textPart(text)] }
    },
  }

  out.web_fetch = {
    description: TOOL_DESCRIPTIONS.web_fetch,
    inputSchema: TOOL_INPUT_SCHEMAS.web_fetch,
    execute: async (input: unknown): Promise<ToolResultPayload> => {
      const args = TOOL_INPUT_SCHEMAS.web_fetch.parse(input) as WebFetchArgs
      const r = await callFirecrawl(args)
      const text = r.title ? `# ${r.title}\n\n${r.markdown}` : r.markdown
      return { content: [textPart(text)] }
    },
  }

  out.code_interpreter = {
    description: TOOL_DESCRIPTIONS.code_interpreter,
    inputSchema: TOOL_INPUT_SCHEMAS.code_interpreter,
    execute: async (input: unknown): Promise<ToolResultPayload> => {
      const args = TOOL_INPUT_SCHEMAS.code_interpreter.parse(input) as CodeInterpreterArgs
      const r = await callE2B(args)
      const text = `STDOUT:\n${r.stdout}\n\nSTDERR:\n${r.stderr}\n\nExit: ${String(r.exitCode)}`
      return { content: [textPart(text)] }
    },
  }

  return out
}
