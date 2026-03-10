import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import {
  GitError,
  branchExists,
  checkoutBranch,
  commit,
  createBranch,
  exec,
  getBranchName,
  getCurrentBranch,
  getDiff,
  getStatus,
  hasUncommittedChanges,
  stageAll,
} from '../../src/lib/git.js';

beforeEach(() => {
  execFileMock.mockReset();
});

describe('git.exec', () => {
  it('resolves stdout on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'hello\n', ''));

    await expect(exec(['status'], '/repo')).resolves.toBe('hello');
  });

  it('throws GitError on non-zero exit with fields', async () => {
    const error = Object.assign(new Error('failed'), { code: 2 });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(error, '', 'bad things'));

    await expect(exec(['status'], '/repo')).rejects.toMatchObject({
      name: 'GitError',
      command: 'git status',
      exitCode: 2,
      stderr: 'bad things',
      message: 'git status failed (exit 2): bad things',
    });
  });
});

describe('git helpers', () => {
  it('getBranchName returns expected format', () => {
    expect(getBranchName('task-1', 'api')).toBe('vexdo/task-1/api');
  });

  it('getDiff returns empty string when no changes', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));

    await expect(getDiff('/repo')).resolves.toBe('');
  });

  it('hasUncommittedChanges returns true/false from porcelain status', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, ' M file.ts\n', ''));
    await expect(hasUncommittedChanges('/repo')).resolves.toBe(true);

    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, '', ''));
    await expect(hasUncommittedChanges('/repo')).resolves.toBe(false);
  });

  it('runs all helper functions with git args', async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === 'rev-parse' && args[3] === 'refs/heads/feature') {
        const error = Object.assign(new Error('missing'), { code: 1 });
        cb(error, '', '');
        return;
      }
      cb(null, 'main\n', '');
    });

    await expect(getCurrentBranch('/repo')).resolves.toBe('main');
    await expect(branchExists('main', '/repo')).resolves.toBe(true);
    await expect(createBranch('feature', '/repo')).resolves.toBeUndefined();
    await expect(checkoutBranch('main', '/repo')).resolves.toBeUndefined();
    await expect(getStatus('/repo')).resolves.toBe('main');
    await expect(stageAll('/repo')).resolves.toBeUndefined();
    await expect(commit('msg', '/repo')).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith('git', ['checkout', '-b', 'feature'], expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith('git', ['checkout', 'main'], expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith('git', ['add', '-A'], expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith('git', ['commit', '-m', 'msg'], expect.any(Object), expect.any(Function));
  });

  it('branchExists returns false on exit code 1', async () => {
    const error = Object.assign(new Error('not found'), { code: 1 });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(error, '', ''));

    await expect(branchExists('missing', '/repo')).resolves.toBe(false);
  });

  it('createBranch throws if branch exists', async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === 'rev-parse') {
        cb(null, 'hash', '');
        return;
      }
      cb(null, '', '');
    });

    await expect(createBranch('existing', '/repo')).rejects.toBeInstanceOf(GitError);
  });
});
