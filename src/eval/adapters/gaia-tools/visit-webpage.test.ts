import { describe, expect, it, vi } from 'vitest'
import { visitWebpage } from './visit-webpage.js'

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html' } })
}

function fetchMock(html: string, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(htmlResponse(html, status)))
}

describe('visitWebpage', () => {
  it('extracts <p>/<h*>/<li> text, drops <script>/<style>', async () => {
    const html = `
      <html><head><title>Page Title</title></head>
      <body>
        <script>var secret = "hidden";</script>
        <style>.hidden { display:none }</style>
        <h1>Heading</h1>
        <p>Hello world.</p>
        <p>Second paragraph.</p>
        <ul><li>Item 1</li><li>Item 2</li></ul>
      </body></html>
    `
    const r = await visitWebpage('https://example.test', { fetchFn: fetchMock(html) })
    expect(r.title).toBe('Page Title')
    expect(r.text_content).toContain('Hello world.')
    expect(r.text_content).toContain('Heading')
    expect(r.text_content).toContain('Item 1')
    expect(r.text_content).not.toContain('hidden')
    expect(r.text_content).not.toContain('var secret')
  })

  it('truncates content beyond maxChars', async () => {
    const long = 'X'.repeat(60_000)
    const html = `<html><body><p>${long}</p></body></html>`
    const r = await visitWebpage('https://example.test', {
      fetchFn: fetchMock(html),
      maxChars: 1000,
    })
    expect(r.text_content.length).toBeLessThan(2000)
    expect(r.text_content).toContain('truncated')
  })

  it('throws on non-OK response', async () => {
    await expect(
      visitWebpage('https://example.test', { fetchFn: fetchMock('not found', 404) }),
    ).rejects.toThrow(/visit_webpage 404/)
  })

  it('falls back to <h1> when no <title>', async () => {
    const html = '<html><body><h1>Fallback</h1><p>Body.</p></body></html>'
    const r = await visitWebpage('https://x', { fetchFn: fetchMock(html) })
    expect(r.title).toBe('Fallback')
  })

  it('returns empty title when neither title nor h1 present', async () => {
    const html = '<html><body><p>Only text.</p></body></html>'
    const r = await visitWebpage('https://x', { fetchFn: fetchMock(html) })
    expect(r.title).toBe('')
    expect(r.text_content).toContain('Only text.')
  })

  it('passes URL through to fetch verbatim', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(htmlResponse('<html><body><p>X</p></body></html>')),
    )
    await visitWebpage('https://anchor.test/path?q=1', { fetchFn })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://anchor.test/path?q=1',
      expect.objectContaining({ redirect: 'follow' }),
    )
  })
})
