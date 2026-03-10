import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
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
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'gh version', ''));

    await expect(checkGhAvailable()).resolves.toBeUndefined();
  });

  it('throws GhNotFoundError when gh not found', async () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(error, '', ''));

    await expect(checkGhAvailable()).rejects.toBeInstanceOf(GhNotFoundError);
  });
});

describe('gh helpers', () => {
  it('createPr returns URL from stdout', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/org/repo/pull/1\n', ''));

    await expect(createPr({ title: 't', body: 'b', cwd: '/repo' })).resolves.toBe(
      'https://github.com/org/repo/pull/1',
    );
  });

  it('getPrUrl returns URL or null', async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, 'https://github.com/org/repo/pull/2\n', ''));
    await expect(getPrUrl('branch', '/repo')).resolves.toBe('https://github.com/org/repo/pull/2');

    const error = Object.assign(new Error('none'), { code: 1 });
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => cb(error, '', ''));
    await expect(getPrUrl('branch', '/repo')).resolves.toBeNull();
  });
});
