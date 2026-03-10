import {execFile as execFileCb} from 'node:child_process';

import * as logger from './logger.js';

const CODEX_TIMEOUT_MS = 600_000;

export interface CodexExecOptions {
  spec: string;
  model: string;
  cwd: string;
  verbose?: boolean;
}

export interface CodexResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CodexError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(stdout: string, stderr: string, exitCode: number) {
    super(`codex exec failed (exit ${String(exitCode)})`);
    this.name = 'CodexError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export class CodexNotFoundError extends Error {
  constructor() {
    super('codex CLI not found. Install it: npm install -g @openai/codex');
    this.name = 'CodexNotFoundError';
  }
}

/**
 * Ensure codex CLI is installed and executable.
 */
export async function checkCodexAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFileCb('codex', ['--version'], { timeout: CODEX_TIMEOUT_MS, encoding: 'utf8' }, (error) => {
      if (error) {
        reject(new CodexNotFoundError());
        return;
      }
      resolve();
    });
  });
}

/**
 * Execute codex with a task spec and model.
 */
export async function exec(opts: CodexExecOptions): Promise<CodexResult> {
  const args = ['exec', '--model', opts.model, '--full-auto', '--', opts.spec];

  return await new Promise<CodexResult>((resolve, reject) => {
    execFileCb(
      'codex',
      args,
      {cwd: opts.cwd, timeout: CODEX_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
      (error, stdout, stderr) => {
        const normalizedStdout = stdout.trimEnd();
        const normalizedStderr = stderr.trimEnd();

        if (opts.verbose) {
          if (normalizedStdout) {
            logger.debug(normalizedStdout);
          }
          if (normalizedStderr) {
            logger.debug(normalizedStderr);
          }
        }

        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          reject(new CodexError(normalizedStdout, normalizedStderr || error.message, exitCode));
          return;
        }

        resolve({
          stdout: normalizedStdout,
          stderr: normalizedStderr,
          exitCode: 0,
        });
      },
    );
  });
}
