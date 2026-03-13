import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkCodexAvailable: vi.fn(),
  codexExec: vi.fn(),
  createBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  getBranchName: vi.fn((taskId: string, service: string) => `vexdo/${taskId}/${service}`),
  runReviewLoop: vi.fn(),
  checkGhAvailable: vi.fn(),
  createPr: vi.fn(),
  ClaudeClient: vi.fn(() => ({})),
}));

vi.mock('../../src/lib/codex.js', () => ({
  checkCodexAvailable: mocks.checkCodexAvailable,
  exec: mocks.codexExec,
}));
vi.mock('../../src/lib/git.js', () => ({
  createBranch: mocks.createBranch,
  checkoutBranch: mocks.checkoutBranch,
  getBranchName: mocks.getBranchName,
}));
vi.mock('../../src/lib/review-loop.js', () => ({
  runReviewLoop: mocks.runReviewLoop,
}));
vi.mock('../../src/lib/gh.js', () => ({
  checkGhAvailable: mocks.checkGhAvailable,
  createPr: mocks.createPr,
}));
vi.mock('../../src/lib/claude.js', () => ({
  ClaudeClient: mocks.ClaudeClient,
}));

import { runStart } from '../../src/commands/start.js';
import { loadState } from '../../src/lib/state.js';

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-start-'));
  tempDirs.push(dir);
  return dir;
}

function setupProject(root: string): void {
  fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
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
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  mocks.getBranchName.mockImplementation((taskId: string, service: string) => `vexdo/${taskId}/${service}`);
  mocks.runReviewLoop.mockResolvedValue({
    decision: 'submit',
    finalIteration: 0,
    lastReviewComments: [],
    lastArbiterResult: { decision: 'submit', reasoning: 'ok', summary: 'ok' },
  });
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('start integration', () => {
  it('Creates branch, moves task to in_progress then review on success', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    await runStart(taskPath, {});

    expect(mocks.createBranch).toHaveBeenCalledWith('vexdo/t1/api', expect.stringMatching(/[\\/]services[\\/]api$/));
    expect(fs.existsSync(path.join(root, 'tasks', 'in_progress', 'task.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'tasks', 'review', 'task.yml'))).toBe(true);
  });

  it('Stops and moves to blocked on escalation', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);
    mocks.runReviewLoop.mockResolvedValueOnce({
      decision: 'escalate',
      finalIteration: 0,
      lastReviewComments: [],
      lastArbiterResult: { decision: 'escalate', reasoning: 'no', summary: 'blocked' },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(runStart(taskPath, {})).rejects.toThrow('exit');
    expect(fs.existsSync(path.join(root, 'tasks', 'blocked', 'task.yml'))).toBe(true);
    exitSpy.mockRestore();
  });

  it('Fatal with hint if active task exists and no --resume', async () => {
    const root = tmpDir();
    setupProject(root);
    fs.mkdirSync(path.join(root, '.vexdo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vexdo', 'state.json'),
      JSON.stringify({ taskId: 'x', taskTitle: 'X', taskPath: 'x', status: 'in_progress', steps: [], startedAt: 'a', updatedAt: 'a' }),
    );
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(runStart(taskPath, {})).rejects.toThrow('exit');
    exitSpy.mockRestore();
  });

  it('--resume skips codex for done steps', async () => {
    const root = tmpDir();
    setupProject(root);
    const inProgressDir = path.join(root, 'tasks', 'in_progress');
    fs.mkdirSync(inProgressDir, { recursive: true });
    const taskPath = path.join(inProgressDir, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    fs.mkdirSync(path.join(root, '.vexdo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vexdo', 'state.json'),
      JSON.stringify({
        taskId: 't1',
        taskTitle: 'Demo',
        taskPath,
        status: 'in_progress',
        steps: [{ service: 'api', status: 'done', iteration: 0, branch: 'vexdo/t1/api' }],
        startedAt: 'a',
        updatedAt: 'a',
      }),
    );
    process.chdir(root);

    await runStart(taskPath, { resume: true });

    expect(mocks.codexExec).not.toHaveBeenCalled();
  });

  it('--resume creates branch and runs codex for pending steps', async () => {
    const root = tmpDir();
    setupProject(root);
    const inProgressDir = path.join(root, 'tasks', 'in_progress');
    fs.mkdirSync(inProgressDir, { recursive: true });
    const taskPath = path.join(inProgressDir, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    fs.mkdirSync(path.join(root, '.vexdo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vexdo', 'state.json'),
      JSON.stringify({
        taskId: 't1',
        taskTitle: 'Demo',
        taskPath,
        status: 'in_progress',
        steps: [{ service: 'api', status: 'pending', iteration: 0 }],
        startedAt: 'a',
        updatedAt: 'a',
      }),
    );
    process.chdir(root);

    await runStart(taskPath, { resume: true });

    expect(mocks.createBranch).toHaveBeenCalledWith('vexdo/t1/api', expect.stringMatching(/[\\/]services[\\/]api$/));
    expect(mocks.codexExec).toHaveBeenCalled();
  });

  it('--dry-run logs plan without codex/review calls and no file moves', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    await runStart(taskPath, { dryRun: true });

    expect(mocks.codexExec).not.toHaveBeenCalled();
    expect(mocks.runReviewLoop).toHaveBeenCalled();
    expect(fs.existsSync(taskPath)).toBe(true);
    expect(loadState(root)).toBeNull();
  });

  it('Invalid task YAML (missing id) fatals and no state created', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'title: Demo\nsteps:\n  - service: api\n    spec: do work\n');
    process.chdir(root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(runStart(taskPath, {})).rejects.toThrow('exit');
    expect(loadState(root)).toBeNull();
    exitSpy.mockRestore();
  });

  it('Service not in config fatals', async () => {
    const root = tmpDir();
    setupProject(root);
    const taskPath = path.join(root, 'task.yml');
    fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: web\n    spec: do work\n');
    process.chdir(root);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(runStart(taskPath, {})).rejects.toThrow('exit');
    exitSpy.mockRestore();
  });
});
