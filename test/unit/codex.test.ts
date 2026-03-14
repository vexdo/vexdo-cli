import {EventEmitter} from 'node:events';

import {beforeEach, describe, expect, it, vi} from 'vitest';

const {spawnMock} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  CodexError,
  CodexNotFoundError,
  CodexTimeoutError,
  checkCodexAvailable,
  getDiff,
  pollStatus,
  resumeTask,
  submitTask,
} from '../../src/lib/codex.js';

function mockSpawnRun(stdoutText: string, stderrText = '', exitCode = 0): void {
  spawnMock.mockImplementation(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();

    setTimeout(() => {
      stdout.emit('data', stdoutText);
      stderr.emit('data', stderrText);
      child.emit('close', exitCode);
    }, 0);

    return child;
  });
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('checkCodexAvailable', () => {
  it('resolves when codex --version exits 0', async () => {
    mockSpawnRun('1.0.0\n');

    await expect(checkCodexAvailable()).resolves.toBeUndefined();
  });

  it('throws CodexNotFoundError when codex is unavailable', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
      return child;
    });

    await expect(checkCodexAvailable()).rejects.toBeInstanceOf(CodexNotFoundError);
  });
});

describe('cloud task lifecycle commands', () => {
  it('submitTask parses session_id', async () => {
    mockSpawnRun('session_id: sess_123\n');

    await expect(submitTask('do work', {cwd: '/repo'})).resolves.toBe('sess_123');
  });

  it('resumeTask parses next session_id', async () => {
    mockSpawnRun('{"session_id":"sess_next"}\n');

    await expect(resumeTask('sess_123', 'fix this')).resolves.toBe('sess_next');
  });

  it('pollStatus resolves completed status', async () => {
    mockSpawnRun('status: completed\n');

    await expect(pollStatus('sess_123', {intervalMs: 1, timeoutMs: 1000})).resolves.toBe('completed');
  });

  it('pollStatus throws timeout when non-terminal status persists', async () => {
    mockSpawnRun('status: running\n');

    await expect(pollStatus('sess_123', {intervalMs: 1, timeoutMs: 5})).rejects.toBeInstanceOf(CodexTimeoutError);
  });

  it('getDiff throws when diff is empty', async () => {
    mockSpawnRun(' \n');

    await expect(getDiff('sess_123')).rejects.toBeInstanceOf(CodexError);
  });
});
