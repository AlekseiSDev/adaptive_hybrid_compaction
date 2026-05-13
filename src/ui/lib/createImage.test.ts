import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionLimitedCreateImage,
  executeCreateImage,
  type CreateImageDeps,
  type CreateImageResult,
} from './createImage';

function makeMockClient(generateContent: (params: unknown) => Promise<unknown>): GoogleGenAI {
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

function pngResponse(base64: string) {
  return {
    candidates: [
      { content: { parts: [{ inlineData: { data: base64, mimeType: 'image/png' } }] } },
    ],
  };
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('executeCreateImage', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'createImage-test-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<CreateImageDeps> = {}): CreateImageDeps {
    return {
      outputDir: tempDir,
      webPathPrefix: '/generated',
      randomId: () => 'fixed-uuid',
      now: () => 1_700_000_000_000,
      maxAgeMs: 60 * 60 * 1000,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      ...overrides,
    };
  }

  it('writes the generated PNG and returns web URL on happy path (no references)', async () => {
    const generateContent = vi.fn().mockResolvedValue(pngResponse(TINY_PNG_BASE64));
    const res = await executeCreateImage(
      { prompt: 'a cat' },
      makeMockClient(generateContent),
      baseDeps(),
    );
    expect(res).toEqual({
      ok: true,
      image_url: '/generated/fixed-uuid.png',
      prompt: 'a cat',
    } satisfies CreateImageResult);

    const written = await readFile(join(tempDir, 'fixed-uuid.png'));
    expect(written.length).toBeGreaterThan(0);

    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash-image',
      contents: [{ text: 'a cat' }],
      config: { responseModalities: ['IMAGE'] },
    });
  });

  it('inlines up to 3 reference images as base64 PNG parts', async () => {
    const generateContent = vi.fn().mockResolvedValue(pngResponse(TINY_PNG_BASE64));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([0x10, 0x20, 0x30]).buffer, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );
    await executeCreateImage(
      {
        prompt: 'collage',
        reference_images: ['u1', 'u2', 'u3', 'u4-ignored'],
      },
      makeMockClient(generateContent),
      baseDeps({ fetchImpl }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const call = generateContent.mock.calls[0]?.[0] as {
      contents: { text?: string; inlineData?: { data: string; mimeType: string } }[];
    };
    expect(call.contents[0]).toEqual({ text: 'collage' });
    expect(call.contents).toHaveLength(4);
    expect(call.contents[1]?.inlineData?.mimeType).toBe('image/png');
    expect(typeof call.contents[1]?.inlineData?.data).toBe('string');
  });

  it('skips reference images whose fetch fails but still proceeds', async () => {
    const generateContent = vi.fn().mockResolvedValue(pngResponse(TINY_PNG_BASE64));
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x10]).buffer, { status: 200 }),
      );
    const res = await executeCreateImage(
      { prompt: 'p', reference_images: ['bad', 'good'] },
      makeMockClient(generateContent),
      baseDeps({ fetchImpl }),
    );
    expect(res.ok).toBe(true);
    const call = generateContent.mock.calls[0]?.[0] as {
      contents: unknown[];
    };
    expect(call.contents).toHaveLength(2);
  });

  it('returns ok:false reason no_image when response has no inlineData', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'sorry' }] } }],
    });
    const res = await executeCreateImage({ prompt: 'p' }, makeMockClient(generateContent), baseDeps());
    expect(res).toEqual({ ok: false, reason: 'no_image' });
  });

  it('returns ok:false reason api_error when generateContent throws', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await executeCreateImage({ prompt: 'p' }, makeMockClient(generateContent), baseDeps());
    expect(res).toEqual({ ok: false, reason: 'api_error' });
  });

  it('cleans up files older than maxAgeMs and leaves fresh files alone', async () => {
    const oldPath = join(tempDir, 'old.png');
    const freshPath = join(tempDir, 'fresh.png');
    await writeFile(oldPath, Buffer.from([1]));
    await writeFile(freshPath, Buffer.from([2]));
    const oldMtime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { utimes } = await import('node:fs/promises');
    await utimes(oldPath, oldMtime, oldMtime);

    const generateContent = vi.fn().mockResolvedValue(pngResponse(TINY_PNG_BASE64));
    await executeCreateImage(
      { prompt: 'p' },
      makeMockClient(generateContent),
      baseDeps({
        now: () => Date.now(),
        maxAgeMs: 60 * 60 * 1000,
      }),
    );

    const oldExists = await stat(oldPath).then(
      () => true,
      () => false,
    );
    const freshExists = await stat(freshPath).then(
      () => true,
      () => false,
    );
    expect(oldExists).toBe(false);
    expect(freshExists).toBe(true);
  });
});

describe('createSessionLimitedCreateImage', () => {
  it('short-circuits to rate_limited without invoking client or fs when tryConsume=false', async () => {
    const generateContent = vi.fn();
    const fetchImpl = vi.fn();
    const writeImpl = vi.fn();
    const tool = createSessionLimitedCreateImage(
      's',
      () => false,
      makeMockClient(generateContent),
      {
        outputDir: '/tmp/__never_written__',
        webPathPrefix: '/generated',
        randomId: () => 'x',
        now: () => 0,
        maxAgeMs: 0,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        writeImpl: writeImpl as unknown as (p: string, d: Buffer) => Promise<void>,
      },
    );
    if (!tool.execute) throw new Error('expected tool.execute to be defined');
    const res = await tool.execute({ prompt: 'p' }, { messages: [], toolCallId: 't' });
    expect(res).toEqual({ ok: false, reason: 'rate_limited' });
    expect(generateContent).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeImpl).not.toHaveBeenCalled();
  });
});
