import { describe, expect, it } from 'vitest';
import { executeFetchUrl, MAX_OUTPUT_CHARS, TIMEOUT_MS } from './fetchUrl';

function makeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe('executeFetchUrl', () => {
  it('returns extracted text on 200 OK HTML', async () => {
    const html = '<html><body><p>hello world</p></body></html>';
    const fetchImpl = () =>
      Promise.resolve(
        makeResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      );

    const res = await executeFetchUrl('https://example.com', { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.trim()).toBe('hello world');
      expect(res.text.length).toBeLessThan(MAX_OUTPUT_CHARS);
    }
  });

  it('caps huge output at MAX_OUTPUT_CHARS and appends [truncated]', async () => {
    const big = 'a'.repeat(MAX_OUTPUT_CHARS + 5000);
    const html = `<html><body><p>${big}</p></body></html>`;
    const fetchImpl = () =>
      Promise.resolve(makeResponse(html, { status: 200, headers: { 'content-type': 'text/html' } }));

    const res = await executeFetchUrl('https://example.com', { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.endsWith(' [truncated]')).toBe(true);
      expect(res.text.length).toBe(MAX_OUTPUT_CHARS + ' [truncated]'.length);
    }
  });

  it('returns http_404 on 404', async () => {
    const fetchImpl = () => Promise.resolve(makeResponse('not found', { status: 404 }));
    const res = await executeFetchUrl('https://example.com/missing', { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('http_404');
  });

  it('returns http_5xx on 503', async () => {
    const fetchImpl = () => Promise.resolve(makeResponse('server down', { status: 503 }));
    const res = await executeFetchUrl('https://example.com', { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('http_503');
  });

  it('returns timeout when fetch aborts with AbortError', async () => {
    const fetchImpl = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const res = await executeFetchUrl('https://example.com/slow', {
      fetchImpl,
      timeoutMs: 10,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timeout');
  });

  it('returns network on generic fetch failure', async () => {
    const fetchImpl = (): Promise<Response> => Promise.reject(new TypeError('connection refused'));
    const res = await executeFetchUrl('https://example.invalid', { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
  });

  it('returns raw text capped for non-HTML content-type', async () => {
    const json = JSON.stringify({ hello: 'world', n: 1 });
    const fetchImpl = () =>
      Promise.resolve(
        makeResponse(json, { status: 200, headers: { 'content-type': 'application/json' } }),
      );

    const res = await executeFetchUrl('https://example.com/api.json', { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('"hello"');
      expect(res.text).toContain('"world"');
    }
  });

  it('exposes default timeout as 5000ms', () => {
    expect(TIMEOUT_MS).toBe(5000);
  });
});
