import { spawn } from 'node:child_process';

import type { CopilotErrorCode } from '../types/index.js';

const COPILOT_TIMEOUT_MS = 30 * 60_000;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

function runCopilotCommand(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; onChunk?: (chunk: string) => void },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn('copilot', args, {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      opts?.onChunk?.(text);
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

export async function generateCommitMessage(spec: string, diff: string, opts?: {cwd?: string}): Promise<string> {
  const prompt =
    `Generate a conventional commit message for the following diff.\n` +
    `Use the spec as context for what was intended.\n` +
    `Rules:\n` +
    `- Format: type(scope): description\n` +
    `- scope is REQUIRED — use the primary module or subsystem changed (e.g. cli, api, git, config, review)\n` +
    `- Types: feat, fix, test, refactor, chore\n` +
    `- Description: imperative mood, concise, no filler words, under 60 characters\n` +
    `- Output ONLY the commit message, no explanation, no markdown, no quotes\n\n` +
    `SPEC:\n${spec}\n\nDIFF:\n${diff}`;

  let result: CommandResult;
  try {
    result = await runCopilotCommand(['-p', prompt, '--silent', '--no-ask-user'], {cwd: opts?.cwd});
  } catch {
    return 'chore: apply codex changes';
  }

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return 'chore: apply codex changes';
  }

  // Take only the first line in case copilot adds explanation
  const firstLine = result.stdout.trim().split('\n')[0] ?? '';
  return firstLine.length > 0 ? firstLine : 'chore: apply codex changes';
}

export interface ReviewIteration {
  diff: string;
  review: string;
  feedbackSentToCodex: string;
}

export async function runCopilotReview(
  spec: string,
  diff: string,
  opts?: {
    cwd?: string;
    history?: ReviewIteration[];
    onChunk?: (chunk: string) => void;
    onRawOutput?: (stdout: string, stderr: string) => void;
  },
): Promise<string> {
  const historySection =
    opts?.history && opts.history.length > 0
      ? '\n\n' +
        opts.history
          .map(
            (h, i) =>
              `PREVIOUS ITERATION ${String(i + 1)} REVIEW:\n${h.review}\n\nFEEDBACK SENT TO CODEX:\n${h.feedbackSentToCodex}`,
          )
          .join('\n\n') +
        '\n\nPlease verify the above issues have been addressed in the new diff.'
      : '';

  const prompt =
    `Review the following diff against the spec.\n` +
    `Report bugs, missing requirements, security issues, and logic errors. Ignore style issues.\n\n` +
    `SPEC:\n${spec}${historySection}\n\nDIFF:\n${diff}`;

  let result: CommandResult;

  try {
    result = await runCopilotCommand(['-p', prompt, '--allow-all-tools', '--no-ask-user'], {
      cwd: opts?.cwd,
      onChunk: opts?.onChunk,
    });
  } catch (error: unknown) {
    throw new CopilotReviewError(
      'review_failed',
      `Failed to execute copilot review: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  opts?.onRawOutput?.(result.stdout, result.stderr);

  if (result.exitCode !== 0) {
    throw new CopilotReviewError('review_failed', 'Copilot review command failed.', result);
  }

  if (!result.stdout.trim()) {
    throw new CopilotReviewError('review_failed', 'Copilot review produced no output.', result);
  }

  return result.stdout.trim();
}
