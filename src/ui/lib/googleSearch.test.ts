import type { GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionLimitedGoogleSearch,
  executeGoogleSearch,
  type GoogleSearchResult,
} from './googleSearch';

function makeMockClient(generateContent: (params: unknown) => Promise<unknown>): GoogleGenAI {
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

describe('executeGoogleSearch', () => {
  it('returns grounded text + flattened citations on happy path', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: 'Hello ' }, { text: 'world.' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://a.example/1', title: 'A' } },
              { web: { uri: 'https://b.example/2', title: 'B' } },
            ],
          },
        },
      ],
    });
    const client = makeMockClient(generateContent);
    const res = await executeGoogleSearch('q', client);
    expect(res).toEqual({
      ok: true,
      text: 'Hello world.',
      citations: [
        { title: 'A', uri: 'https://a.example/1' },
        { title: 'B', uri: 'https://b.example/2' },
      ],
    } satisfies GoogleSearchResult);
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: 'q',
      config: { tools: [{ googleSearch: {} }] },
    });
  });

  it('returns empty citations when groundingMetadata is missing', async () => {
    const client = makeMockClient(() =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'no grounding' }] } }],
      }),
    );
    const res = await executeGoogleSearch('q', client);
    expect(res).toEqual({ ok: true, text: 'no grounding', citations: [] });
  });

  it('filters out citations missing uri', async () => {
    const client = makeMockClient(() =>
      Promise.resolve({
        candidates: [
          {
            content: { parts: [{ text: 't' }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://a.example', title: 'A' } },
                { web: { title: 'B-no-uri' } },
                { retrievedContext: { uri: 'rc' } },
              ],
            },
          },
        ],
      }),
    );
    const res = await executeGoogleSearch('q', client);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toEqual([{ title: 'A', uri: 'https://a.example' }]);
    }
  });

  it('returns ok:false reason api_error when generateContent throws', async () => {
    const client = makeMockClient(() => Promise.reject(new Error('boom')));
    const res = await executeGoogleSearch('q', client);
    expect(res).toEqual({ ok: false, reason: 'api_error' });
  });
});

describe('createSessionLimitedGoogleSearch', () => {
  it('short-circuits to rate_limited without invoking the client when tryConsume=false', async () => {
    const generateContent = vi.fn();
    const client = makeMockClient(generateContent);
    const tool = createSessionLimitedGoogleSearch('s', () => false, client);
    if (!tool.execute) throw new Error('expected tool.execute to be defined');
    const res = await tool.execute({ query: 'q' }, { messages: [], toolCallId: 't' });
    expect(res).toEqual({ ok: false, reason: 'rate_limited' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('invokes the client when tryConsume=true', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    const client = makeMockClient(generateContent);
    const tool = createSessionLimitedGoogleSearch('s', () => true, client);
    if (!tool.execute) throw new Error('expected tool.execute to be defined');
    const res = await tool.execute({ query: 'q' }, { messages: [], toolCallId: 't' });
    expect(res).toEqual({ ok: true, text: 'ok', citations: [] });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
