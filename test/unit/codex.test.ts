import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));
const { debugMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  debug: debugMock,
}));

import { CodexError, CodexNotFoundError, checkCodexAvailable, exec } from '../../src/lib/codex.js';

beforeEach(() => {
  execFileMock.mockReset();
  debugMock.mockReset();
});

describe('checkCodexAvailable', () => {
  it('resolves when codex --version exits 0', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '1.0.0', ''));

    await expect(checkCodexAvailable()).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object), expect.any(Function));
  });

  it('throws CodexNotFoundError when codex not found', async () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(error, '', ''));

    await expect(checkCodexAvailable()).rejects.toBeInstanceOf(CodexNotFoundError);
  });
});

describe('codex.exec', () => {
  it('resolves CodexResult on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'done\n', 'warn\n'));

    await expect(exec({ spec: 'do it', model: 'gpt-4o', cwd: '/repo' })).resolves.toEqual({
      stdout: 'done',
      stderr: 'warn',
      exitCode: 0,
    });
  });

  it('throws CodexError on non-zero exit', async () => {
    const error = Object.assign(new Error('bad'), { code: 9 });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(error, 'partial', 'failed'));

    await expect(exec({ spec: 'do it', model: 'gpt-4o', cwd: '/repo' })).rejects.toBeInstanceOf(CodexError);
  });

  it('verbose mode passes output to logger.debug', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'out', 'err'));

    await exec({ spec: 'do it', model: 'gpt-4o', cwd: '/repo', verbose: true });

    expect(debugMock).toHaveBeenCalledWith('out');
    expect(debugMock).toHaveBeenCalledWith('err');
  });

  it('verbose mode streams stdout/stderr while process is running', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      setTimeout(() => {
        stdout.emit('data', 'phase 1\n');
        stderr.emit('data', 'warn 1\n');
        cb(null, 'phase 1\nphase 2\n', 'warn 1\n');
      }, 0);

      return { stdout, stderr };
    });

    await exec({ spec: 'do it', model: 'gpt-4o', cwd: '/repo', verbose: true });

    expect(debugMock).toHaveBeenCalledWith('[codex:stdout] phase 1');
    expect(debugMock).toHaveBeenCalledWith('[codex:stderr] warn 1');
    expect(debugMock).not.toHaveBeenCalledWith('phase 1\nphase 2');
  });
});
