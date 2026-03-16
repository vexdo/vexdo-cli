import {execFile as execFileCb} from 'node:child_process';

const GH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;

export interface CreatePrOptions {
  title: string;
  body: string;
  head: string;
  base?: string;
  cwd: string;
}

export class GhNotFoundError extends Error {
  constructor() {
    super('gh CLI not found. Install it: https://cli.github.com');
    this.name = 'GhNotFoundError';
  }
}

class GitCommandError extends Error {
  exitCode: number;
  stderr: string;

  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${String(exitCode)}): ${stderr}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

async function execGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFileCb('git', args, {cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8'}, (error, _stdout, stderr) => {
      if (error) {
        const exitCode = typeof error.code === 'number' ? error.code : -1;
        reject(new GitCommandError(args, exitCode, (stderr || error.message).trim()));
        return;
      }
      resolve();
    });
  });
}

function isNoUpstreamError(error: GitCommandError): boolean {
  const text = error.stderr.toLowerCase();
  return text.includes('no upstream configured for branch') || text.includes('has no upstream branch');
}

async function pushCurrentBranch(cwd: string): Promise<void> {
  try {
    await execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
    await execGit(['push'], cwd);
  } catch (error: unknown) {
    if (error instanceof GitCommandError && isNoUpstreamError(error)) {
      await execGit(['push', '--set-upstream', 'origin', 'HEAD'], cwd);
      return;
    }
    throw error;
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
      ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', base, '--head', opts.head],
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
