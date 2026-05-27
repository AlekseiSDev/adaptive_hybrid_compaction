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

  // K-tail-3 fix (2026-05-27, Bug #3): content-type filtering.
  it('throws on application/pdf — no UTF-8 garbage in tool_result', async () => {
    // Simulate Wikimedia returning a PDF (gaia_010 hit this on a 1959 USDA
    // standards PDF). Previously: 123KB of binary leaked into actor context.
    const pdfFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('%PDF-1.4 binary garbage', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    )
    await expect(
      visitWebpage('https://example.test/doc.pdf', { fetchFn: pdfFetch }),
    ).rejects.toThrow(/unsupported content-type "application\/pdf"/)
  })

  it('throws on application/octet-stream and image/jpeg', async () => {
    const octetFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('bin', {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ),
    )
    await expect(
      visitWebpage('https://example.test/x.bin', { fetchFn: octetFetch }),
    ).rejects.toThrow(/unsupported content-type/)
    const imgFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('jpg', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
      ),
    )
    await expect(
      visitWebpage('https://example.test/p.jpg', { fetchFn: imgFetch }),
    ).rejects.toThrow(/unsupported content-type "image\/jpeg"/)
  })

  it('accepts text/plain', async () => {
    const plain = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('hello plain world', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
      ),
    )
    const r = await visitWebpage('https://example.test/raw', { fetchFn: plain })
    expect(r.text_content).toContain('hello plain world')
  })

  it('accepts application/rss+xml and extracts via root().text() fallback', async () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
      <item><title>Post 1</title><description>First story</description></item>
      <item><title>Post 2</title><description>Second story</description></item>
    </channel></rss>`
    const rssFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(rss, {
          status: 200,
          headers: { 'Content-Type': 'application/rss+xml' },
        }),
      ),
    )
    const r = await visitWebpage('https://example.test/feed.rss', { fetchFn: rssFetch })
    // Cheerio doesn't find <p>/<h*>/<li> in RSS → fallback path triggers.
    expect(r.text_content).toContain('Post 1')
    expect(r.text_content).toContain('First story')
  })

  it('falls back to cleaned text when HTML has no standard text-bearing tags', async () => {
    // Some sites wrap everything in <div>s (SPA shells). After boilerplate
    // removal, root().text() still has the visible text.
    const html =
      '<html><body><script>x</script><div>Visible content here</div></body></html>'
    const r = await visitWebpage('https://x', { fetchFn: fetchMock(html) })
    expect(r.text_content).toContain('Visible content here')
    expect(r.text_content).not.toContain('script')
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
