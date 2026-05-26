import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeImage } from './describe-image.js'

// 1x1 PNG (transparent).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('describeImage', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ahc-gaia-img-'))
  })
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('encodes PNG as data-URL and calls OpenRouter', async () => {
    writeFileSync(join(workspaceDir, 'pixel.png'), PNG_BYTES)
    const fetchFn = vi.fn<typeof fetch>((url, init) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      expect(urlStr).toContain('/chat/completions')
      const body = JSON.parse(init?.body as string) as {
        messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]
      }
      const content = body.messages[0]?.content ?? []
      const imagePart = content.find((c) => c.type === 'image_url')
      expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/)
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: 'A small transparent pixel.' } }] }),
      )
    })
    const r = await describeImage(workspaceDir, 'pixel.png', 'what is this?', {
      apiKey: 'test-key',
      fetchFn,
    })
    expect(r.description).toBe('A small transparent pixel.')
    expect(r.cost_usd).toBe(0)
  })

  it('throws when API key missing', async () => {
    writeFileSync(join(workspaceDir, 'pixel.png'), PNG_BYTES)
    const saved = process.env['OPENROUTER_API_KEY']
    Reflect.deleteProperty(process.env, 'OPENROUTER_API_KEY')
    try {
      await expect(describeImage(workspaceDir, 'pixel.png', 'q')).rejects.toThrow(
        /OPENROUTER_API_KEY/,
      )
    } finally {
      if (saved !== undefined) process.env['OPENROUTER_API_KEY'] = saved
    }
  })

  it('blocks path traversal', async () => {
    await expect(
      describeImage(workspaceDir, '../../etc/passwd', 'q', { apiKey: 'k' }),
    ).rejects.toThrow(/escapes workspace/)
  })

  it('surfaces non-OK response as error', async () => {
    writeFileSync(join(workspaceDir, 'p.png'), PNG_BYTES)
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('rate-limited', { status: 429 })),
    )
    await expect(
      describeImage(workspaceDir, 'p.png', 'q', { apiKey: 'k', fetchFn }),
    ).rejects.toThrow(/describe_image 429/)
  })
})
