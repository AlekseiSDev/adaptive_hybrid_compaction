import { tool } from 'ai';
import type { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { getGoogleGenAIClient } from './googleGenai';

const MODEL = 'gemini-2.5-flash';

const DESCRIPTION =
  'Search the web via Google. Returns a grounded answer with citations. Use this when the user asks about current events, facts, or anything you do not already know.';

const INPUT = z.object({
  query: z.string().describe('The natural-language search query.'),
});

export type GoogleSearchResult =
  | { ok: true; text: string; citations: { title: string; uri: string }[] }
  | { ok: false; reason: string };

export async function executeGoogleSearch(
  query: string,
  client: GoogleGenAI = getGoogleGenAIClient(),
): Promise<GoogleSearchResult> {
  let response: unknown;
  try {
    response = await client.models.generateContent({
      model: MODEL,
      contents: query,
      config: { tools: [{ googleSearch: {} }] },
    });
  } catch {
    return { ok: false, reason: 'api_error' };
  }

  const candidate = (response as { candidates?: unknown[] }).candidates?.[0] as
    | {
        content?: { parts?: { text?: string }[] };
        groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
      }
    | undefined;

  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const citations = chunks
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => typeof w?.uri === 'string')
    .map((w) => ({ title: w.title ?? '', uri: w.uri }));

  return { ok: true, text, citations };
}

export function createSessionLimitedGoogleSearch(
  sessionId: string,
  tryConsume: (sessionId: string) => boolean,
  client?: GoogleGenAI,
) {
  return tool({
    description: DESCRIPTION,
    inputSchema: INPUT,
    execute: async ({ query }): Promise<GoogleSearchResult> => {
      if (!tryConsume(sessionId)) return { ok: false, reason: 'rate_limited' };
      return executeGoogleSearch(query, client ?? getGoogleGenAIClient());
    },
  });
}
