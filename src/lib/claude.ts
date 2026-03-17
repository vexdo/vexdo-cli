import Anthropic from '@anthropic-ai/sdk';

import { ARBITER_SYSTEM_PROMPT } from '../prompts/arbiter.js';
import * as logger from './logger.js';
import { REVIEWER_SYSTEM_PROMPT } from '../prompts/reviewer.js';
import type { ArbiterResult, ReviewComment, ReviewResult } from '../types/index.js';

const REVIEWER_MAX_TOKENS_DEFAULT = 4096;
const ARBITER_MAX_TOKENS_DEFAULT = 2048;
const MAX_ATTEMPTS = 3;

export interface ReviewerOptions {
  spec: string;
  diff: string;
  model: string;
  maxTokens?: number;
}

export interface ArbiterOptions {
  spec: string;
  diff: string;
  reviewText: string;
  model: string;
  maxTokens?: number;
}

export interface ExpandFeedbackOptions {
  spec: string;
  feedback: string;
  model: string;
}

export class ClaudeError extends Error {
  attempt: number;
  cause: unknown;

  constructor(attempt: number, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Claude API failed after ${String(attempt)} attempts: ${message}`);
    this.name = 'ClaudeError';
    this.attempt = attempt;
    this.cause = cause;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ClaudeClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async runReviewer(opts: ReviewerOptions): Promise<ReviewResult> {
    return this.runWithRetry(async () => {
      const response = await this.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? REVIEWER_MAX_TOKENS_DEFAULT,
        system: REVIEWER_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `SPEC:\n${opts.spec}\n\nDIFF:\n${opts.diff}`,
          },
        ],
      });

      return parseReviewerResult(extractTextFromResponse(response));
    });
  }

  async expandFeedback(opts: ExpandFeedbackOptions): Promise<string> {
    return this.runWithRetry(async () => {
      const response = await this.client.messages.create({
        model: opts.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content:
              `You are preparing a detailed fix instruction for a code agent (Codex).\n\n` +
              `ORIGINAL TASK SPEC:\n${opts.spec}\n\n` +
              `USER FEEDBACK — what needs to be fixed or improved:\n${opts.feedback}\n\n` +
              `Write a detailed, actionable fix instruction for Codex. Include:\n` +
              `- What specifically needs to change and why\n` +
              `- Any relevant technical details inferable from the context\n` +
              `- References to the original spec where relevant\n\n` +
              `Output ONLY the instruction, no preamble or explanation.`,
          },
        ],
      });

      return extractTextFromResponse(response);
    });
  }

  async runArbiter(opts: ArbiterOptions): Promise<ArbiterResult> {
    return this.runWithRetry(async () => {
      const response = await this.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? ARBITER_MAX_TOKENS_DEFAULT,
        system: ARBITER_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `SPEC:\n${opts.spec}\n\nDIFF:\n${opts.diff}\n\nREVIEWER COMMENTS:\n${opts.reviewText}`,
          },
        ],
      });

      return parseArbiterResult(extractTextFromResponse(response));
    });
  }

  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown = new Error('Unknown Claude failure');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;

        if (!isRetryableError(error) || attempt === MAX_ATTEMPTS) {
          throw new ClaudeError(attempt, error);
        }

        const backoffMs = 1000 * 2 ** (attempt - 1);
        logger.warn(
          `Claude API error on attempt ${String(attempt)}/${String(MAX_ATTEMPTS)}. Retrying in ${String(Math.round(backoffMs / 1000))}s...`,
        );
        await sleep(backoffMs);
      }
    }

    throw new ClaudeError(MAX_ATTEMPTS, lastError);
  }
}

function extractTextFromResponse(response: unknown): string {
  const content =
    typeof response === 'object' && response !== null && 'content' in response
      ? (response as { content?: unknown }).content
      : null;

  if (!Array.isArray(content)) {
    throw new Error('Claude response missing content array');
  }

  const text = content
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null && 'type' in block)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Claude response had no text content');
  }

  return text;
}

function extractJson(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  return trimmed;
}

function parseReviewerResult(raw: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error: unknown) {
    throw new Error(`Failed to parse reviewer JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isReviewResult(parsed)) {
    throw new Error('Reviewer JSON does not match schema');
  }

  return parsed;
}

function parseArbiterResult(raw: string): ArbiterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (error: unknown) {
    throw new Error(`Failed to parse arbiter JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isArbiterResult(parsed)) {
    throw new Error('Arbiter JSON does not match schema');
  }

  return parsed;
}

function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!['critical', 'important', 'minor', 'noise'].includes(String(candidate.severity))) {
    return false;
  }
  if (typeof candidate.comment !== 'string') {
    return false;
  }
  if (candidate.file !== undefined && typeof candidate.file !== 'string') {
    return false;
  }
  if (candidate.line !== undefined && typeof candidate.line !== 'number') {
    return false;
  }
  return !(candidate.suggestion !== undefined && typeof candidate.suggestion !== 'string');
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const comments = (value as { comments?: unknown }).comments;
  return Array.isArray(comments) && comments.every((comment) => isReviewComment(comment));
}

function isArbiterResult(value: unknown): value is ArbiterResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (!['fix', 'submit', 'escalate'].includes(String(candidate.decision))) {
    return false;
  }
  if (typeof candidate.reasoning !== 'string' || typeof candidate.summary !== 'string') {
    return false;
  }

  if (candidate.decision === 'fix') {
    return typeof candidate.feedback_for_codex === 'string' && candidate.feedback_for_codex.length > 0;
  }

  return candidate.feedback_for_codex === undefined;
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }

  return undefined;
}

function isRetryableError(error: unknown): boolean {
  const status = getStatusCode(error);
  if (status === 400 || status === 401 || status === 403) {
    return false;
  }
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }

  return true;
}
