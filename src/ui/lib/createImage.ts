import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tool } from 'ai';
import type { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { getGoogleGenAIClient } from './googleGenai';

const MODEL = 'gemini-2.5-flash-image';
const MAX_REFERENCES = 3;
const DEFAULT_OUTPUT_DIR = resolve(process.cwd(), 'src/ui/public/generated');
const DEFAULT_WEB_PREFIX = '/generated';
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

const DESCRIPTION =
  'Generate or edit an image with Gemini. Pass up to 3 reference image URLs (PNG/JPEG) to do img2img / variations. Returns a relative URL the chat UI can render directly.';

const INPUT = z.object({
  prompt: z.string().describe('What the image should show.'),
  reference_images: z
    .array(z.string())
    .max(MAX_REFERENCES)
    .optional()
    .describe(`Optional URLs of up to ${String(MAX_REFERENCES)} reference images for img2img / edit.`),
});

export type CreateImageInput = z.infer<typeof INPUT>;

export type CreateImageResult =
  | { ok: true; image_url: string; prompt: string }
  | { ok: false; reason: string };

export type CreateImageDeps = {
  outputDir: string;
  webPathPrefix: string;
  randomId: () => string;
  now: () => number;
  maxAgeMs: number;
  fetchImpl: typeof fetch;
  writeImpl?: (path: string, data: Buffer) => Promise<void>;
  readdirImpl?: (path: string) => Promise<string[]>;
  statImpl?: (path: string) => Promise<{ mtimeMs: number }>;
  unlinkImpl?: (path: string) => Promise<void>;
};

const defaultDeps = (): CreateImageDeps => ({
  outputDir: DEFAULT_OUTPUT_DIR,
  webPathPrefix: DEFAULT_WEB_PREFIX,
  randomId: () => randomUUID(),
  now: () => Date.now(),
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  fetchImpl: fetch,
});

async function cleanupOldFiles(deps: CreateImageDeps): Promise<void> {
  const readdirFn = deps.readdirImpl ?? readdir;
  const statFn = deps.statImpl ?? ((p) => stat(p));
  const unlinkFn = deps.unlinkImpl ?? unlink;
  let entries: string[];
  try {
    entries = await readdirFn(deps.outputDir);
  } catch {
    return;
  }
  const cutoff = deps.now() - deps.maxAgeMs;
  for (const name of entries) {
    if (!name.endsWith('.png')) continue;
    const p = join(deps.outputDir, name);
    try {
      const s = await statFn(p);
      if (s.mtimeMs < cutoff) {
        try {
          await unlinkFn(p);
        } catch {
          // ENOENT race — ignore
        }
      }
    } catch {
      // missing between readdir and stat — ignore
    }
  }
}

async function fetchAsBase64(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch {
    return null;
  }
}

export async function executeCreateImage(
  input: CreateImageInput,
  client: GoogleGenAI,
  deps: CreateImageDeps = defaultDeps(),
): Promise<CreateImageResult> {
  await cleanupOldFiles(deps);

  const contents: ({ text: string } | { inlineData: { data: string; mimeType: string } })[] = [{ text: input.prompt }];

  const refs = (input.reference_images ?? []).slice(0, MAX_REFERENCES);
  for (const url of refs) {
    const data = await fetchAsBase64(url, deps.fetchImpl);
    if (data) contents.push({ inlineData: { data, mimeType: 'image/png' } });
  }

  let response: unknown;
  try {
    response = await client.models.generateContent({
      model: MODEL,
      contents,
      config: { responseModalities: ['IMAGE'] },
    });
  } catch {
    return { ok: false, reason: 'api_error' };
  }

  const parts = (response as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { data?: string; mimeType?: string } }[];
      };
    }[];
  }).candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => typeof p.inlineData?.data === 'string');
  const imageData = imagePart?.inlineData?.data;
  if (!imageData) return { ok: false, reason: 'no_image' };

  const filename = `${deps.randomId()}.png`;
  const writeFn = deps.writeImpl ?? writeFile;
  try {
    await mkdir(deps.outputDir, { recursive: true });
    await writeFn(join(deps.outputDir, filename), Buffer.from(imageData, 'base64'));
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  return {
    ok: true,
    image_url: `${deps.webPathPrefix}/${filename}`,
    prompt: input.prompt,
  };
}

export function createSessionLimitedCreateImage(
  sessionId: string,
  tryConsume: (sessionId: string) => boolean,
  client?: GoogleGenAI,
  deps?: CreateImageDeps,
) {
  return tool({
    description: DESCRIPTION,
    inputSchema: INPUT,
    execute: async (input): Promise<CreateImageResult> => {
      if (!tryConsume(sessionId)) return { ok: false, reason: 'rate_limited' };
      return executeCreateImage(input, client ?? getGoogleGenAIClient(), deps ?? defaultDeps());
    },
  });
}
