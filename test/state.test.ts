import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearState,
  createState,
  getStatePath,
  hasActiveTask,
  loadState,
  saveIterationLog,
  saveState,
  updateStep,
} from '../src/lib/state.js';
import type { TaskStatus, VexdoState } from '../src/types/index.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('state', () => {
  it('returns null when absent', () => {
    const root = makeTempDir();
    expect(loadState(root)).toBeNull();
  });

  it('save/load roundtrip works', () => {
    const root = makeTempDir();
    const created = createState('task-1', 'Task 1', '/tmp/task.yml', [
      { service: 'api', status: 'pending', iteration: 0, currentStepIndex: 0 },
    ]);

    saveState(root, created);
    const loaded = loadState(root);

    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe('task-1');
    expect(loaded?.taskTitle).toBe('Task 1');
    expect(loaded?.steps[0]?.service).toBe('api');
  });

  it('throws on corrupt JSON', () => {
    const root = makeTempDir();
    const statePath = getStatePath(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{ not-json', 'utf8');

    expect(() => loadState(root)).toThrowError(/Corrupt state file/);
  });

  it('clearState removes file and is idempotent', () => {
    const root = makeTempDir();
    const state = createState('task-1', 'Task 1', '/tmp/task.yml', []);
    saveState(root, state);

    clearState(root);
    clearState(root);

    expect(loadState(root)).toBeNull();
  });

  it('hasActiveTask handles all statuses', () => {
    const root = makeTempDir();
    const statuses: TaskStatus[] = ['in_progress', 'review', 'done', 'blocked', 'escalated'];

    for (const status of statuses) {
      const base: VexdoState = {
        taskId: 'id',
        taskTitle: 'title',
        taskPath: '/tmp/task.yml',
        status,
        steps: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveState(root, base);
      const expected = status === 'in_progress' || status === 'review';
      expect(hasActiveTask(root)).toBe(expected);
    }
  });

  it('createState sets expected fields', () => {
    const state = createState('task-1', 'Task 1', '/tmp/task.yml', [
      { service: 'api', status: 'pending', iteration: 0, currentStepIndex: 0 },
    ]);

    expect(state.taskId).toBe('task-1');
    expect(state.taskTitle).toBe('Task 1');
    expect(state.taskPath).toBe('/tmp/task.yml');
    expect(state.status).toBe('in_progress');
    expect(state.startedAt).toBeTruthy();
    expect(state.updatedAt).toBe(state.startedAt);
  });

  it('updateStep re-reads and persists merged state', async () => {
    const root = makeTempDir();
    const original = createState('task-1', 'Task 1', '/tmp/task.yml', [
      { service: 'api', status: 'pending', iteration: 0, currentStepIndex: 0 },
      { service: 'web', status: 'pending', iteration: 0, currentStepIndex: 1 },
    ]);

    saveState(root, original);
    await updateStep(root, 'task-1', 'api', {
      status: 'in_progress',
      iteration: 1,
    });

    const updated = loadState(root);
    expect(updated?.steps[0]?.status).toBe('in_progress');
    expect(updated?.steps[0]?.iteration).toBe(1);
    expect(updated?.steps[1]?.status).toBe('pending');
  });

  it('saveIterationLog creates diff, review, and arbiter files', () => {
    const root = makeTempDir();

    saveIterationLog(root, 'task-1', 'api', 2, {
      diff: 'diff content',
      review: 'important: Needs work',
      arbiter: {
        decision: 'fix',
        reasoning: 'Please address comments',
        summary: 'One important issue',
      },
    });

    const logsDir = path.join(root, '.vexdo', 'logs', 'task-1');
    expect(fs.existsSync(path.join(logsDir, 'api-iteration-2-diff.txt'))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, 'api-iteration-2-review.txt'))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, 'api-iteration-2-arbiter.json'))).toBe(true);
  });
});
