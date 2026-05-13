import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type UIMessage,
} from 'ai';
import { createAhcMiddleware } from '../../../../adapters';
import { SYSTEM_PROMPT } from '../../../lib/systemPrompt';
import { parseFlagsFromUrl } from '../../../lib/featureFlags';
import { createSessionLimitedFetchUrl } from '../../../lib/fetchUrl';
import { FETCH_RATE_LIMITER, SESSION_REGISTRY } from '../../../lib/sessionRegistry';

export const runtime = 'nodejs';

const DEFAULT_MAX_STEPS = 8;
const MAX_STEPS_HARD_CAP = 16;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL_ID = 'google/gemini-3-flash-preview';

function clampSteps(raw: string | null): number {
  if (!raw) return DEFAULT_MAX_STEPS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(n, MAX_STEPS_HARD_CAP);
}

function readSessionId(req: Request): string {
  const explicit = req.headers.get('x-session-id');
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return 'anonymous';
}

export async function POST(req: Request) {
  const { OPENROUTER_API_KEY: apiKey } = process.env;
  if (!apiKey) {
    return new Response('OPENROUTER_API_KEY is not set', { status: 500 });
  }

  const url = new URL(req.url);
  const maxSteps = clampSteps(url.searchParams.get('MAX_STEPS'));
  const flags = parseFlagsFromUrl(url);
  const sessionId = readSessionId(req);

  SESSION_REGISTRY.evictIdle();

  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const modelMessages = await convertToModelMessages(messages);

  const openrouter = createOpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  const baseModel = openrouter(MODEL_ID);

  const middleware = createAhcMiddleware({
    flags,
    sessionId: () => sessionId,
    scratchpadRegistry: SESSION_REGISTRY,
  });
  const model = wrapLanguageModel({ model: baseModel, middleware });

  const fetchUrl = createSessionLimitedFetchUrl(sessionId, (id) =>
    FETCH_RATE_LIMITER.tryConsume(id),
  );

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(maxSteps),
    tools: { fetch_url: fetchUrl },
  });

  return result.toUIMessageStreamResponse();
}
