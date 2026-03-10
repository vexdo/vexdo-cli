import * as codex from './codex.js';
import * as gh from './gh.js';

export function requireAnthropicApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  return apiKey;
}

export async function requireCodexAvailable(): Promise<void> {
  await codex.checkCodexAvailable();
}

export async function requireGhAvailable(): Promise<void> {
  await gh.checkGhAvailable();
}
