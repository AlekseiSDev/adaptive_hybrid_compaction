import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetClientForTests, getGoogleGenAIClient } from './googleGenai';

const SAVED_KEY = process.env.GOOGLE_GENAI_API_KEY;

describe('getGoogleGenAIClient', () => {
  beforeEach(() => {
    __resetClientForTests();
  });

  afterEach(() => {
    __resetClientForTests();
    if (SAVED_KEY === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
    else process.env.GOOGLE_GENAI_API_KEY = SAVED_KEY;
  });

  it('throws a clear error when GOOGLE_GENAI_API_KEY is not set', () => {
    delete process.env.GOOGLE_GENAI_API_KEY;
    expect(() => getGoogleGenAIClient()).toThrow(/GOOGLE_GENAI_API_KEY/);
  });

  it('caches the client across calls (referential equality)', () => {
    process.env.GOOGLE_GENAI_API_KEY = 'test-key-not-used';
    const a = getGoogleGenAIClient();
    const b = getGoogleGenAIClient();
    expect(a).toBe(b);
  });

  it('__resetClientForTests forces a fresh client on next call', () => {
    process.env.GOOGLE_GENAI_API_KEY = 'test-key-not-used';
    const a = getGoogleGenAIClient();
    __resetClientForTests();
    const b = getGoogleGenAIClient();
    expect(a).not.toBe(b);
  });
});
