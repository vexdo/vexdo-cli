import type { ExecFileException } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
type ExecFileMockImpl = (cmd: string, args: string[], opts: unknown, cb: ExecFileCallback) => void;

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMockImpl>(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { GhNotFoundError, checkGhAvailable, createPr, getPrUrl } from '../../src/lib/gh.js';

beforeEach(() => {
  execFileMock.mockReset();
});

describe('checkGhAvailable', () => {
  it('resolves when gh is present', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'gh version', '');
    });

    await expect(checkGhAvailable()).resolves.toBeUndefined();
  });

  it('throws GhNotFoundError when gh not found', async () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(error, '', '');
    });

    await expect(checkGhAvailable()).rejects.toBeInstanceOf(GhNotFoundError);
  });
});

describe('gh helpers', () => {
  it('createPr returns URL from stdout', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        cb(null, 'origin/feature\n', '');
        return;
      }
      if (cmd === 'git' && args[0] === 'push') {
        cb(null, '', '');
        return;
      }
      cb(null, 'https://github.com/org/repo/pull/1\n', '');
    });

    await expect(createPr({ title: 't', body: 'b', cwd: '/repo' })).resolves.toBe(
      'https://github.com/org/repo/pull/1',
    );
  });

  it('createPr sets upstream automatically when branch has no upstream', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        const error = Object.assign(new Error('no upstream'), { code: 128 });
        cb(error, '', 'fatal: no upstream configured for branch');
        return;
      }
      if (cmd === 'git' && args[0] === 'push' && args.includes('--set-upstream')) {
        cb(null, '', '');
        return;
      }
      cb(null, 'https://github.com/org/repo/pull/3\n', '');
    });

    await expect(createPr({ title: 't', body: 'b', cwd: '/repo' })).resolves.toBe(
      'https://github.com/org/repo/pull/3',
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['push', '--set-upstream', 'origin', 'HEAD'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('createPr fails when push fails', async () => {
    execFileMock.mockImplementation((cmd, args, _opts, cb) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        cb(null, 'origin/feature\n', '');
        return;
      }
      if (cmd === 'git' && args[0] === 'push') {
        const error = Object.assign(new Error('denied'), { code: 1 });
        cb(error, '', 'fatal: permission denied');
        return;
      }
      cb(null, 'https://github.com/org/repo/pull/4\n', '');
    });

    await expect(createPr({ title: 't', body: 'b', cwd: '/repo' })).rejects.toThrow(
      'Failed to push current branch before creating PR',
    );
  });

  it('getPrUrl returns URL or null', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(null, 'https://github.com/org/repo/pull/2\n', '');
    });
    await expect(getPrUrl('branch', '/repo')).resolves.toBe('https://github.com/org/repo/pull/2');

    const error = Object.assign(new Error('none'), { code: 1 });
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(error, '', '');
    });
    await expect(getPrUrl('branch', '/repo')).resolves.toBeNull();
  });
});
