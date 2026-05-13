import * as cheerio from 'cheerio';
import { tool } from 'ai';
import { z } from 'zod';

export const MAX_OUTPUT_CHARS = 8000;
export const TIMEOUT_MS = 5000;
const TRUNCATION_SUFFIX = ' [truncated]';

export type FetchUrlResult =
  | { ok: true; text: string; contentType: string }
  | { ok: false; reason: string };

export type FetchUrlOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function executeFetchUrl(
  url: string,
  options: FetchUrlOptions = {},
): Promise<FetchUrlResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network' };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, reason: `http_${String(response.status)}` };
  }

  const contentType = response.headers.get('content-type') ?? '';
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: 'body_read_failed' };
  }

  const text = contentType.includes('text/html') ? cheerio.load(body).text() : body;
  return { ok: true, text: capOutput(text), contentType };
}

function capOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_SUFFIX;
}

const FETCH_URL_DESCRIPTION =
  'Fetch a URL via HTTP GET and return its text content. HTML is stripped to plain text. Use this to retrieve web pages, articles, or any text resource the user asks about.';

const FETCH_URL_INPUT = z.object({
  url: z.string().describe('The full http(s) URL to fetch.'),
});

export const fetchUrlTool = tool({
  description: FETCH_URL_DESCRIPTION,
  inputSchema: FETCH_URL_INPUT,
  execute: async ({ url }) => executeFetchUrl(url),
});

export function createSessionLimitedFetchUrl(
  sessionId: string,
  tryConsume: (sessionId: string) => boolean,
) {
  return tool({
    description: FETCH_URL_DESCRIPTION,
    inputSchema: FETCH_URL_INPUT,
    execute: async ({ url }): Promise<FetchUrlResult> => {
      if (!tryConsume(sessionId)) return { ok: false, reason: 'rate_limited' };
      return executeFetchUrl(url);
    },
  });
}
