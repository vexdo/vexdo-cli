import {execFile as execFileCb} from 'node:child_process';

const GH_TIMEOUT_MS = 30_000;

export interface CreatePrOptions {
  title: string;
  body: string;
  base?: string;
  cwd: string;
}

export class GhNotFoundError extends Error {
  constructor() {
    super('gh CLI not found. Install it: https://cli.github.com');
    this.name = 'GhNotFoundError';
  }
}

/**
 * Ensure GitHub CLI is installed and executable.
 */
export async function checkGhAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFileCb('gh', ['--version'], { timeout: GH_TIMEOUT_MS, encoding: 'utf8' }, (error) => {
      if (error) {
        reject(new GhNotFoundError());
        return;
      }
      resolve();
    });
  });
}

/**
 * Create a pull request and return the new PR URL.
 */
export async function createPr(opts: CreatePrOptions): Promise<string> {
  const base = opts.base ?? 'main';
  return await new Promise<string>((resolve, reject) => {
    execFileCb(
      'gh',
      ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', base],
      {cwd: opts.cwd, timeout: GH_TIMEOUT_MS, encoding: 'utf8'},
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Return an existing PR URL for a branch, or null when no PR exists.
 */
export async function getPrUrl(branch: string, cwd: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    execFileCb(
      'gh',
      ['pr', 'view', branch, '--json', 'url', '--jq', '.url'],
      {cwd, timeout: GH_TIMEOUT_MS, encoding: 'utf8'},
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const url = stdout.trim();
        resolve(url || null);
      },
    );
  });
}
