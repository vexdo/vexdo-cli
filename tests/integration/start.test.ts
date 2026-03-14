import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  checkCodexAvailable: vi.fn(),
  submitTask: vi.fn(),
  pollStatus: vi.fn(),
  getDiff: vi.fn(),
  resumeTask: vi.fn(),
  createBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  getBranchName: vi.fn((taskId: string, service: string) => `vexdo/${taskId}/${service}`),
  checkGhAvailable: vi.fn(),
  createPr: vi.fn(),
  ClaudeClient: vi.fn(),
}));

vi.mock('../../src/lib/codex.js', () => ({
  checkCodexAvailable: mocks.checkCodexAvailable,
  submitTask: mocks.submitTask,
  pollStatus: mocks.pollStatus,
  getDiff: mocks.getDiff,
  resumeTask: mocks.resumeTask,
}));
vi.mock('../../src/lib/git.js', () => ({
  createBranch: mocks.createBranch,
  checkoutBranch: mocks.checkoutBranch,
  getBranchName: mocks.getBranchName,
}));
vi.mock('../../src/lib/gh.js', () => ({
  checkGhAvailable: mocks.checkGhAvailable,
  createPr: mocks.createPr,
}));
vi.mock('../../src/lib/claude.js', () => ({
  ClaudeClient: mocks.ClaudeClient,
}));

import {runStart} from '../../src/commands/start.js';
import {loadState} from '../../src/lib/state.js';

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-start-'));
  tempDirs.push(dir);
  return dir;
}

function setupProject(root: string): void {
  fs.mkdirSync(path.join(root, 'services', 'api'), {recursive: true});
  fs.writeFileSync(
    path.join(root, '.vexdo.yml'),
    `version: 1
services:
  - name: api
    path: ./services/api
review:
  model: m
  max_iterations: 3
  auto_submit: false
codex:
  model: c
`,
  );
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      (fn as unknown as {mockReset: () => void}).mockReset();
    }
  }

  mocks.getBranchName.mockImplementation((taskId: string, service: string) => `vexdo/${taskId}/${service}`);
  mocks.submitTask.mockResolvedValue('sess-1');
  mocks.pollStatus.mockResolvedValue('completed');
  mocks.getDiff.mockResolvedValue('diff --git a/x b/x');
  mocks.resumeTask.mockResolvedValue('sess-2');

  mocks.ClaudeClient.mockImplementation(() => ({
    runReviewer: vi.fn().mockResolvedValue({comments: []}),
    runArbiter: vi.fn().mockResolvedValue({decision: 'submit', reasoning: 'ok', summary: 'ok'}),
  }));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('start integration', () => {
  it('Creates branch, moves task to review, and uses codex cloud flow', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    await runStart(taskPath, {});

    expect(mocks.createBranch).toHaveBeenCalledWith('vexdo/t1/api', expect.stringMatching(/[\\/]services[\\/]api$/));
    expect(mocks.submitTask).toHaveBeenCalled();
    expect(mocks.pollStatus).toHaveBeenCalledWith('sess-1', expect.objectContaining({intervalMs: 5_000, timeoutMs: 600_000}));
    expect(mocks.getDiff).toHaveBeenCalledWith('sess-1');
    expect(fs.existsSync(path.join(root, 'tasks', 'review', 'task.yml'))).toBe(true);
  });

  it('Uses resumeTask when arbiter requests fixes', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    mocks.ClaudeClient.mockImplementation(() => ({
      runReviewer: vi.fn().mockResolvedValue({comments: []}),
      runArbiter: vi
        .fn()
        .mockResolvedValueOnce({decision: 'fix', reasoning: 'x', summary: 'x', feedback_for_codex: 'please fix'})
        .mockResolvedValueOnce({decision: 'submit', reasoning: 'ok', summary: 'ok'}),
    }));

    await runStart(taskPath, {});

    expect(mocks.resumeTask).toHaveBeenCalledWith('sess-1', 'please fix');
    expect(mocks.pollStatus).toHaveBeenCalledWith('sess-2', expect.any(Object));
  });

  it('Persists and reuses session_id during --resume', async () => {
    const root = tmpDir();
    setupProject(root);
    const inProgressDir = path.join(root, 'tasks', 'in_progress');
    fs.mkdirSync(inProgressDir, {recursive: true});
    const taskPath = path.join(inProgressDir, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    fs.mkdirSync(path.join(root, '.vexdo'), {recursive: true});
    fs.writeFileSync(
      path.join(root, '.vexdo', 'state.json'),
      JSON.stringify({
        taskId: 't1',
        taskTitle: 'Demo',
        taskPath,
        status: 'in_progress',
        steps: [{service: 'api', status: 'in_progress', iteration: 0, branch: 'vexdo/t1/api', session_id: 'sess-existing'}],
        startedAt: 'a',
        updatedAt: 'a',
      }),
    );
    process.chdir(root);

    await runStart(taskPath, {resume: true});

    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(mocks.pollStatus).toHaveBeenCalledWith('sess-existing', expect.any(Object));
  });

  it('--dry-run skips cloud execution and no file moves', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    await runStart(taskPath, {dryRun: true});

    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(fs.existsSync(taskPath)).toBe(true);
    expect(loadState(root)).toBeNull();
  });
});
