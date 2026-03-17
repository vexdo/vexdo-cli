import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { checkCopilotAvailable, CopilotNotFoundError, CopilotReviewError, runCopilotReview } from '../../src/lib/copilot.js';

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

describe('checkCopilotAvailable', () => {
  it('resolves when copilot --version exits 0', async () => {
    mockSpawnRun('1.2.3\n');
    await expect(checkCopilotAvailable()).resolves.toBeUndefined();
  });

  it('throws CopilotNotFoundError when copilot cannot be started', async () => {
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

    await expect(checkCopilotAvailable()).rejects.toBeInstanceOf(CopilotNotFoundError);
  });
});

describe('runCopilotReview', () => {
  it('returns raw stdout text from copilot', async () => {
    mockSpawnRun('{"message":"Null dereference","severity":"high","file":"src/a.ts","line":13}\n');

    await expect(runCopilotReview('spec', 'diff', { cwd: '/repo' })).resolves.toBe(
      '{"message":"Null dereference","severity":"high","file":"src/a.ts","line":13}',
    );
  });

  it('returns raw output when copilot succeeds', async () => {
    mockSpawnRun('{"event":"done"}\nnot-json\n');
    await expect(runCopilotReview('spec', 'diff')).resolves.toBe('{"event":"done"}\nnot-json');
  });

  it('throws CopilotReviewError when command fails', async () => {
    mockSpawnRun('oops', 'broken', 1);
    await expect(runCopilotReview('spec', 'diff')).rejects.toBeInstanceOf(CopilotReviewError);
  });

  it('throws CopilotReviewError when stdout is empty', async () => {
    mockSpawnRun(' \n');
    await expect(runCopilotReview('spec', 'diff')).rejects.toBeInstanceOf(CopilotReviewError);
  });
});
