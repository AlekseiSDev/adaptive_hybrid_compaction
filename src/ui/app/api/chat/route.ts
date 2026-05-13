import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type UIMessage,
} from 'ai';
import { createAhcMiddleware } from '../../../../adapters';
import type { CoreEvent } from '../../../../core';
import { activeFlagNames, parseFlagsFromUrl } from '../../../lib/featureFlags';
import { createSessionLimitedFetchUrl } from '../../../lib/fetchUrl';
import { FETCH_RATE_LIMITER, SESSION_REGISTRY } from '../../../lib/sessionRegistry';
import { buildAhcStats } from '../../../lib/ahcStats';
import type { AhcStatsEnvelope } from '../../../lib/ahcStatsTypes';
import { SYSTEM_PROMPT } from '../../../lib/systemPrompt';

export const runtime = 'nodejs';

const DEFAULT_MAX_STEPS = 8;
const MAX_STEPS_HARD_CAP = 16;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL_ID = 'google/gemini-3-flash-preview';

type AhcUIMessage = UIMessage<unknown, { ahc_stats: AhcStatsEnvelope }>;

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
  // .chat() routes through OpenAI Chat Completions API; openrouter(MODEL_ID) would
  // call the newer Responses API, which OpenRouter doesn't accept (returns
  // "Invalid Responses API request" mid-stream after tool calls).
  const baseModel = openrouter.chat(MODEL_ID);

  const events: CoreEvent[] = [];
  let lastObservationsCount = 0;
  let lastScratchpadSize = 0;

  const middleware = createAhcMiddleware({
    flags,
    sessionId: () => sessionId,
    scratchpadRegistry: SESSION_REGISTRY,
    emit: (event) => events.push(event),
    onCompactResult: (_sid, result) => {
      lastObservationsCount = result.newTier2.observations.length;
      lastScratchpadSize = SESSION_REGISTRY.get(sessionId).size();
    },
  });
  const model = wrapLanguageModel({ model: baseModel, middleware });

  const fetchUrl = createSessionLimitedFetchUrl(sessionId, (id) =>
    FETCH_RATE_LIMITER.tryConsume(id),
  );

  const activeFlags = activeFlagNames(flags);

  const stream = createUIMessageStream<AhcUIMessage>({
    execute: ({ writer }) => {
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: modelMessages,
        stopWhen: stepCountIs(maxSteps),
        tools: { fetch_url: fetchUrl },
        onFinish: ({ usage }) => {
          const envelope = buildAhcStats({
            events,
            observationsCount: lastObservationsCount,
            scratchpadSize: lastScratchpadSize,
            activeFlags,
            usage,
            modelId: MODEL_ID,
          });
          writer.write({ type: 'data-ahc_stats', data: envelope });
        },
      });
      writer.merge(result.toUIMessageStream());
    },
  });

  return createUIMessageStreamResponse({ stream });
}
