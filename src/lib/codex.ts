import {execFile as execFileCb} from 'node:child_process';
import type {Readable} from 'node:stream';

import * as logger from './logger.js';

const CODEX_TIMEOUT_MS = 600_000;
const VERBOSE_HEARTBEAT_MS = 15_000;

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

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${String(seconds)}s`;
}

function buildVerboseStreamHandler(label: 'stdout' | 'stderr'): {
  onData: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let partialLine = '';

  return {
    onData(chunk: Buffer | string): void {
      partialLine += chunk.toString();
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) {
          continue;
        }
        logger.debug(`[codex:${label}] ${line}`);
      }
    },
    flush(): void {
      if (!partialLine) {
        return;
      }
      logger.debug(`[codex:${label}] ${partialLine}`);
      partialLine = '';
    },
  };
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
  const startedAt = Date.now();

  if (opts.verbose) {
    logger.debug(`[codex] starting (model=${opts.model}, cwd=${opts.cwd})`);
  }

  return await new Promise<CodexResult>((resolve, reject) => {
    let liveLogsAttached = false;
    const stdoutHandler = buildVerboseStreamHandler('stdout');
    const stderrHandler = buildVerboseStreamHandler('stderr');

    const heartbeat = opts.verbose
      ? setInterval(() => {
          logger.debug(`[codex] still running (${formatElapsed(startedAt)})`);
        }, VERBOSE_HEARTBEAT_MS)
      : null;

    const child = execFileCb(
      'codex',
      args,
      {cwd: opts.cwd, timeout: CODEX_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
      (error, stdout, stderr) => {
        if (heartbeat) {
          clearInterval(heartbeat);
        }

        stdoutHandler.flush();
        stderrHandler.flush();

        const normalizedStdout = stdout.trimEnd();
        const normalizedStderr = stderr.trimEnd();

        if (opts.verbose) {
          logger.debug(`[codex] finished in ${formatElapsed(startedAt)}`);
          if (!liveLogsAttached && normalizedStdout) {
            logger.debug(normalizedStdout);
          }
          if (!liveLogsAttached && normalizedStderr) {
            logger.debug(normalizedStderr);
          }
        }

        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          if (opts.verbose) {
            logger.debug(`[codex] failed in ${formatElapsed(startedAt)} with exit ${String(exitCode)}`);
          }
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

    if (opts.verbose) {
      const stdout = child.stdout as Readable | null;
      const stderr = child.stderr as Readable | null;
      if (stdout) {
        liveLogsAttached = true;
        stdout.on('data', stdoutHandler.onData);
      }
      if (stderr) {
        liveLogsAttached = true;
        stderr.on('data', stderrHandler.onData);
      }
    }
  });
}
