import { execFile as execFileCb } from 'node:child_process';

const GIT_TIMEOUT_MS = 30_000;

/** Error thrown when a git command fails. */
export class GitError extends Error {
  command: string;
  exitCode: number;
  stderr: string;

  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${String(exitCode)}): ${stderr}`);
    this.name = 'GitError';
    this.command = `git ${args.join(' ')}`;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Run a git command in a specific working directory.
 */
export async function exec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const exitCode = typeof error.code === 'number' ? error.code : -1;
        reject(new GitError(args, exitCode, (stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  return exec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * Check whether a local branch exists.
 */
export async function branchExists(name: string, cwd: string): Promise<boolean> {
  try {
    await exec(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

/**
 * Create and checkout a new branch.
 */
export async function fetchBranch(branch: string, cwd: string): Promise<void> {
  await exec(['fetch', 'origin', branch], cwd);
}

export async function createBranch(name: string, cwd: string, baseBranch?: string): Promise<void> {
  if (await branchExists(name, cwd)) {
    throw new GitError(['checkout', '-b', name], 128, `branch '${name}' already exists`);
  }
  const base = baseBranch ? `origin/${baseBranch}` : undefined;
  const args = base ? ['checkout', '-b', name, base] : ['checkout', '-b', name];
  await exec(args, cwd);
}

/**
 * Checkout an existing branch.
 */
export async function checkoutBranch(name: string, cwd: string): Promise<void> {
  await exec(['checkout', name], cwd);
}

/**
 * Get the git diff for the working directory.
 */
export async function getDiff(cwd: string, base?: string): Promise<string> {
  if (base) {
    return exec(['diff', `${base}..HEAD`], cwd);
  }
  return exec(['diff', 'HEAD'], cwd);
}

/**
 * Get porcelain status output.
 */
export async function getStatus(cwd: string): Promise<string> {
  return exec(['status', '--porcelain'], cwd);
}

/**
 * Return whether the repository has uncommitted changes.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await getStatus(cwd);
  return status.length > 0;
}

/**
 * Stage all changes.
 */
export async function stageAll(cwd: string): Promise<void> {
  await exec(['add', '-A'], cwd);
}

/**
 * Commit staged changes.
 */
export async function commit(message: string, cwd: string): Promise<void> {
  await exec(['commit', '-m', message], cwd);
}

/**
 * Stage all changes and commit.
 */
export async function commitAll(message: string, cwd: string): Promise<void> {
  await exec(['add', '-A'], cwd);
  await exec(['commit', '-m', message], cwd);
}

/**
 * Push branch to origin.
 */
export async function push(branch: string, cwd: string): Promise<void> {
  await exec(['push', '--set-upstream', 'origin', branch], cwd);
}

/**
 * Build the task branch name for a service.
 */
export function getBranchName(taskId: string, service: string): string {
  return `vexdo/${taskId}/${service}`;
}
