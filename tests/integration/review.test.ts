import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runReviewLoop: vi.fn(),
  ClaudeClient: vi.fn(() => ({})),
  codexCheck: vi.fn(),
  codexExec: vi.fn(),
  ghCheck: vi.fn(),
  ghCreate: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitBranchName: vi.fn(),
}));

vi.mock('../../src/lib/review-loop.js', () => ({ runReviewLoop: mocks.runReviewLoop }));
vi.mock('../../src/lib/claude.js', () => ({ ClaudeClient: mocks.ClaudeClient }));
vi.mock('../../src/lib/codex.js', () => ({ checkCodexAvailable: mocks.codexCheck, exec: mocks.codexExec }));
vi.mock('../../src/lib/gh.js', () => ({ checkGhAvailable: mocks.ghCheck, createPr: mocks.ghCreate }));
vi.mock('../../src/lib/git.js', () => ({ createBranch: mocks.gitCreateBranch, checkoutBranch: mocks.gitCheckoutBranch, getBranchName: mocks.gitBranchName }));

import { runReview } from '../../src/commands/review.js';

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-review-'));
  tempDirs.push(dir);
  return dir;
}

function setupProject(root: string): void {
  fs.mkdirSync(path.join(root, 'tasks', 'in_progress'), { recursive: true });
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
  const taskPath = path.join(root, 'tasks', 'in_progress', 'task.yml');
  fs.writeFileSync(taskPath, 'id: t1\ntitle: Demo\nsteps:\n  - service: api\n    spec: do work\n');
  fs.mkdirSync(path.join(root, '.vexdo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.vexdo', 'state.json'),
    JSON.stringify({
      taskId: 't1',
      taskTitle: 'Demo',
      taskPath,
      status: 'in_progress',
      steps: [{ service: 'api', status: 'in_progress', iteration: 0, branch: 'vexdo/t1/api' }],
      startedAt: 'a',
      updatedAt: 'a',
    }),
  );
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'k';
  mocks.runReviewLoop.mockReset();
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

describe('review integration', () => {
  it('No active task -> fatal', async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.vexdo.yml'), 'version: 1\nservices:\n  - name: api\n    path: ./services/api\n');
    process.chdir(root);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(runReview({})).rejects.toThrow('exit');
    exitSpy.mockRestore();
  });

  it('Runs review loop on current step', async () => {
    const root = tmpDir();
    setupProject(root);
    process.chdir(root);

    await runReview({});

    expect(mocks.runReviewLoop).toHaveBeenCalledTimes(1);
  });

  it('Handles submit', async () => {
    const root = tmpDir();
    setupProject(root);
    process.chdir(root);

    await runReview({});

    const state = JSON.parse(fs.readFileSync(path.join(root, '.vexdo', 'state.json'), 'utf8')) as { steps: { status: string }[] };
    expect(state.steps[0]?.status).toBe('done');
  });

  it('Handles escalate', async () => {
    const root = tmpDir();
    setupProject(root);
    process.chdir(root);
    mocks.runReviewLoop.mockResolvedValueOnce({
      decision: 'escalate',
      finalIteration: 0,
      lastReviewComments: [],
      lastArbiterResult: { decision: 'escalate', reasoning: 'x', summary: 'x' },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(runReview({})).rejects.toThrow('exit');
    expect(fs.existsSync(path.join(root, 'tasks', 'blocked', 'task.yml'))).toBe(true);
    exitSpy.mockRestore();
  });
});
