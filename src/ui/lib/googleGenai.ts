import { GoogleGenAI } from '@google/genai';

let cached: GoogleGenAI | null = null;

export function getGoogleGenAIClient(): GoogleGenAI {
  if (cached) return cached;
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey || apiKey === '<paste-here>') {
    throw new Error('GOOGLE_GENAI_API_KEY is not set');
  }
  cached = new GoogleGenAI({ apiKey });
  return cached;
}

export function __resetClientForTests(): void {
  cached = null;
}
