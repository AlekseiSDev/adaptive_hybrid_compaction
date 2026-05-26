// `describe_image` tool for GAIA. Per docs/design/K_gaia.md §4.2.
//
// Vision LLM call via OpenRouter. Reads image from workspaceDir, encodes
// to base64, sends to gpt-5.4-mini (vision-capable per decisions.md
// 2026-05-13 D4). Returns natural-language description for actor agent
// to integrate into reasoning.

import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export type DescribeImageResult = {
  description: string
  cost_usd: number
}

export type DescribeImageOptions = {
  model?: string
  apiKey?: string
  baseURL?: string
  fetchFn?: typeof fetch
}

const DEFAULT_MODEL = 'openai/gpt-5.4-mini'
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.gif') return 'image/gif'
  if (e === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

export async function describeImage(
  workspaceDir: string,
  imagePath: string,
  question: string,
  opts: DescribeImageOptions = {},
): Promise<DescribeImageResult> {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('describe_image: OPENROUTER_API_KEY env required')
  }
  const baseURL = opts.baseURL ?? DEFAULT_BASE_URL
  const model = opts.model ?? DEFAULT_MODEL
  const fetchFn = opts.fetchFn ?? fetch

  // Resolve image path within workspaceDir for safety.
  const rootAbs = resolve(workspaceDir)
  const target = resolve(rootAbs, imagePath)
  if (!target.startsWith(rootAbs + '/') && target !== rootAbs) {
    throw new Error(`describe_image: path "${imagePath}" escapes workspace`)
  }
  const bytes = await readFile(target)
  const b64 = bytes.toString('base64')
  const mime = mimeForExt(extname(imagePath))
  const dataUrl = `data:${mime};base64,${b64}`

  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    throw new Error(`describe_image ${String(res.status)}: ${await res.text()}`)
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const description = body.choices?.[0]?.message?.content ?? ''
  // Cost not bubbled here — runner-side cost accounting via OpenRouter
  // pricing happens in runGaiaTask; describe_image returns 0 to keep the
  // tool surface free of pricing coupling. Future: thread `cost_usd`
  // through if/when we want per-tool cost split.
  return { description, cost_usd: 0 }
}
