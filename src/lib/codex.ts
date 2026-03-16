import {spawn} from 'node:child_process';

const CODEX_TIMEOUT_MS = 600_000;

export type CodexTaskStatus = 'completed' | 'failed';

export class CodexError extends Error {
  code:
    | 'submit_failed'
    | 'resume_failed'
    | 'poll_timeout'
    | 'poll_failed'
    | 'diff_empty'
    | 'apply_failed';
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(
    code:
      | 'submit_failed'
      | 'resume_failed'
      | 'poll_timeout'
      | 'poll_failed'
      | 'diff_empty'
      | 'apply_failed',
    message: string,
    details?: {stdout?: string; stderr?: string; exitCode?: number},
  ) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
    this.stdout = details?.stdout ?? '';
    this.stderr = details?.stderr ?? '';
    this.exitCode = details?.exitCode ?? 1;
  }
}

export class CodexTimeoutError extends CodexError {
  sessionId: string;

  constructor(sessionId: string, timeoutMs: number) {
    super(
      'poll_timeout',
      `Timed out waiting for codex cloud session ${sessionId} after ${String(timeoutMs)}ms. Check status with: codex cloud status ${sessionId}`,
    );
    this.name = 'CodexTimeoutError';
    this.sessionId = sessionId;
  }
}

export class CodexNotFoundError extends Error {
  constructor() {
    super('codex CLI not found. Install it: npm install -g @openai/codex');
    this.name = 'CodexNotFoundError';
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCodexCommand(args: string[], opts?: {cwd?: string; timeoutMs?: number}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn('codex', args, {
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
      reject(new Error(`codex command timed out after ${String(opts?.timeoutMs ?? CODEX_TIMEOUT_MS)}ms`));
    }, opts?.timeoutMs ?? CODEX_TIMEOUT_MS);

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

function parseSessionId(output: string): string | null {
  // session_id: <value> or sessionId=<value>
  const kvMatch = /session[_-]?id\s*[:=]\s*([A-Za-z0-9._-]+)/i.exec(output);
  if (kvMatch?.[1]) {
    return kvMatch[1];
  }

  // https://.../codex/tasks/<task_id>
  const urlMatch = /\/codex\/tasks\/([A-Za-z0-9._-]+)/i.exec(output);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as {session_id?: unknown};
      if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
        return parsed.session_id;
      }
    } catch {
      // ignore non-json lines
    }
  }

  return null;
}

type CodexPollStatus = CodexTaskStatus | 'pending';

function parseStatus(output: string): CodexPollStatus | null {
  const bracketMatch = /\[(COMPLETED|READY|FAILED|PENDING|RUNNING|IN_PROGRESS)\]/i.exec(output);
  if (bracketMatch?.[1]) {
    const s = bracketMatch[1].toLowerCase();
    if (s === 'completed' || s === 'ready') return 'completed';
    if (s === 'failed') return 'failed';
    return 'pending';
  }

  const wordMatch = /\b(completed|ready|failed|pending|running)\b/i.exec(output);
  if (!wordMatch?.[1]) {
    return null;
  }

  const s = wordMatch[1].toLowerCase();
  if (s === 'completed' || s === 'ready') return 'completed';
  if (s === 'failed') return 'failed';
  return 'pending';
}

export async function checkCodexAvailable(): Promise<void> {
  try {
    const result = await runCodexCommand(['--version']);
    if (result.exitCode !== 0) {
      throw new CodexNotFoundError();
    }
  } catch {
    throw new CodexNotFoundError();
  }
}

export async function submitTask(prompt: string, options?: {cwd?: string; envId?: string; branch?: string}): Promise<string> {
  const args = ['cloud', 'exec', '--env', options?.envId ?? ''];
  if (options?.branch) {
    args.push('--branch', options.branch);
  }
  args.push(prompt);

  const result = await runCodexCommand(args, {cwd: options?.cwd});
  const sessionId = parseSessionId(result.stdout);

  if (result.exitCode !== 0 || !sessionId) {
    throw new CodexError('submit_failed', 'Failed to submit task to codex cloud.', result);
  }

  return sessionId;
}

export async function resumeTask(
  spec: string,
  feedback: string,
  options?: {cwd?: string; envId?: string; branch?: string; taskTitle?: string; iteration?: number},
): Promise<string> {
  const header = [
    `[REVIEW FEEDBACK — FIX REQUESTED]`,
    options?.taskTitle ? `Task: ${options.taskTitle}` : null,
    options?.iteration !== undefined ? `Iteration: ${String(options.iteration)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `${header}\n\n${spec}\n\nIssues to fix:\n${feedback}`;
  return submitTask(prompt, options);
}

export async function pollStatus(sessionId: string, opts: {intervalMs: number; timeoutMs: number}): Promise<CodexTaskStatus> {
  const startedAt = Date.now();

  for (;;) {
    const result = await runCodexCommand(['cloud', 'status', sessionId]);

    const status = parseStatus(result.stdout);

    if (result.exitCode !== 0 && status === null) {
      throw new CodexError('poll_failed', `Failed to poll codex cloud status for session ${sessionId}.`, result);
    }

    if (status === 'completed' || status === 'failed') {
      return status;
    }

    if (Date.now() - startedAt >= opts.timeoutMs) {
      throw new CodexTimeoutError(sessionId, opts.timeoutMs);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, opts.intervalMs);
    });
  }
}

export async function getDiff(sessionId: string, options?: {cwd?: string}): Promise<string> {
  const result = await runCodexCommand(['cloud', 'diff', sessionId], {cwd: options?.cwd});
  if (result.exitCode !== 0) {
    throw new CodexError('poll_failed', `Failed to get diff for codex cloud session ${sessionId}.`, result);
  }

  if (!result.stdout.trim()) {
    throw new CodexError('diff_empty', `Diff was empty for codex cloud session ${sessionId}.`, result);
  }

  return result.stdout;
}

export async function applyDiff(sessionId: string, options?: {cwd?: string}): Promise<void> {
  const result = await runCodexCommand(['cloud', 'apply', sessionId], {cwd: options?.cwd});
  if (result.exitCode !== 0) {
    throw new CodexError('apply_failed', `Failed to apply diff for codex cloud session ${sessionId}.`, result);
  }
}

export async function exec(opts: {spec: string; cwd: string; model?: string; verbose?: boolean}): Promise<void> {
  const sessionId = await submitTask(opts.spec, {cwd: opts.cwd});
  const status = await pollStatus(sessionId, {intervalMs: 2_000, timeoutMs: CODEX_TIMEOUT_MS});
  if (status !== 'completed') {
    throw new CodexError('submit_failed', `Codex cloud session ${sessionId} ended with status '${status}'.`);
  }
  await applyDiff(sessionId);
}
