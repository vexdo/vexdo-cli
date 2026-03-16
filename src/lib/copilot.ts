import { spawn } from 'node:child_process';

import type { CommentSeverity, CopilotErrorCode, ReviewComment } from '../types/index.js';

const COPILOT_TIMEOUT_MS = 120_000;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedComment {
  message: string;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
}

/**
 * `copilot --output-format=json` emits JSONL (one JSON object per line). The schema appears to vary
 * across versions, so this parser is intentionally defensive: it scans parsed object trees for
 * message-like fields (`message`/`body`/`text`) plus optional location/severity metadata.
 */
export class CopilotReviewError extends Error {
  code: CopilotErrorCode;
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(code: CopilotErrorCode, message: string, details?: { stdout?: string; stderr?: string; exitCode?: number }) {
    super(message);
    this.name = 'CopilotReviewError';
    this.code = code;
    this.stdout = details?.stdout ?? '';
    this.stderr = details?.stderr ?? '';
    this.exitCode = details?.exitCode ?? 1;
  }
}

export class CopilotNotFoundError extends CopilotReviewError {
  constructor() {
    super('not_found', 'copilot CLI not found. Install and authenticate GitHub Copilot CLI, then retry.');
    this.name = 'CopilotNotFoundError';
  }
}

function runCopilotCommand(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn('copilot', args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`copilot command timed out after ${String(opts?.timeoutMs ?? COPILOT_TIMEOUT_MS)}ms`));
    }, opts?.timeoutMs ?? COPILOT_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });
  });
}

function normalizeSeverity(raw: unknown): CommentSeverity {
  const sev = typeof raw === 'string' ? raw.toLowerCase() : '';

  if (sev === 'error' || sev === 'high' || sev === 'critical') {
    return 'critical';
  }

  if (sev === 'warning' || sev === 'medium') {
    return 'important';
  }

  if (sev === 'info' || sev === 'low') {
    return 'minor';
  }

  return 'minor';
}

function maybeNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n)) {
      return n;
    }
  }

  return undefined;
}

function collectParsedComments(value: unknown, comments: ParsedComment[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectParsedComments(item, comments);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;

  const message = [record.message, record.body, record.text].find((field) => typeof field === 'string');

  if (typeof message === 'string' && message.trim()) {
    comments.push({
      message: message.trim(),
      severity: record.severity ?? record.priority,
      file: record.file ?? record.path,
      line: record.line,
    });
  }

  for (const nested of Object.values(record)) {
    collectParsedComments(nested, comments);
  }
}

function parseReviewComments(stdout: string): ReviewComment[] {
  const parsedObjects: unknown[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      parsedObjects.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines.
    }
  }

  const parsed: ParsedComment[] = [];
  for (const entry of parsedObjects) {
    collectParsedComments(entry, parsed);
  }

  const deduped = new Set<string>();
  const output: ReviewComment[] = [];

  for (const item of parsed) {
    const file = typeof item.file === 'string' && item.file.length > 0 ? item.file : undefined;
    const line = maybeNumber(item.line);
    const lineKey = line === undefined ? '' : String(line);
    const key = `${item.message}::${file ?? ''}::${lineKey}`;

    if (deduped.has(key)) {
      continue;
    }

    deduped.add(key);
    output.push({
      severity: normalizeSeverity(item.severity),
      file,
      line,
      comment: item.message,
    });
  }

  return output;
}

export async function checkCopilotAvailable(): Promise<void> {
  try {
    const result = await runCopilotCommand(['--version']);
    if (result.exitCode !== 0) {
      throw new CopilotNotFoundError();
    }
  } catch {
    throw new CopilotNotFoundError();
  }
}

export async function runCopilotReview(spec: string, opts?: { cwd?: string }): Promise<ReviewComment[]> {
  const prompt = `Review the staged changes against the following spec.\nReport bugs, missing requirements, security issues, and logic errors.\nIgnore style issues.\n\nSpec:\n${spec}`;

  let result: CommandResult;

  try {
    result = await runCopilotCommand(['-p', prompt, '--silent', '--output-format=json'], { cwd: opts?.cwd });
  } catch (error: unknown) {
    throw new CopilotReviewError(
      'review_failed',
      `Failed to execute copilot review: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result.exitCode !== 0) {
    throw new CopilotReviewError('review_failed', 'Copilot review command failed.', result);
  }

  if (!result.stdout.trim()) {
    throw new CopilotReviewError('review_failed', 'Copilot review produced no output.', result);
  }

  try {
    return parseReviewComments(result.stdout);
  } catch (error: unknown) {
    throw new CopilotReviewError(
      'parse_failed',
      `Failed to parse Copilot review output: ${error instanceof Error ? error.message : String(error)}`,
      result,
    );
  }
}
