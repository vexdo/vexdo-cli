import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadBoardState } from '../../src/lib/board.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-board-'));
  tempDirs.push(dir);
  return dir;
}

function writeTask(root: string, column: string, fileName: string, id: string, title: string): void {
  const dir = path.join(root, 'tasks', column);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), `id: ${id}\ntitle: ${title}\n`, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadBoardState', () => {
  it('loads all columns and marks blocked tasks', async () => {
    const root = makeTempDir();
    writeTask(root, 'backlog', 'task-a.yml', 'task-a', 'Task A');
    writeTask(root, 'in_progress', 'task-b.yml', 'task-b', 'Task B');
    writeTask(root, 'review', 'task-c.yml', 'task-c', 'Task C');
    writeTask(root, 'done', 'task-d.yml', 'task-d', 'Task D');
    writeTask(root, 'blocked', 'task-e.yml', 'task-e', 'Task E');

    const board = await loadBoardState(root);

    expect(board.backlog.map((item) => item.id)).toEqual(['task-a']);
    expect(board.in_progress.map((item) => item.id)).toEqual(['task-b']);
    expect(board.review.map((item) => item.id)).toEqual(['task-c']);
    expect(board.done.map((item) => item.id)).toEqual(['task-d']);
    expect(board.blocked[0]).toMatchObject({ id: 'task-e', blocked: true });
  });

  it('limits done column to 20 most recent files', async () => {
    const root = makeTempDir();
    const doneDir = path.join(root, 'tasks', 'done');
    fs.mkdirSync(doneDir, { recursive: true });

    for (let index = 0; index < 25; index += 1) {
      const id = `task-${String(index).padStart(2, '0')}`;
      const filePath = path.join(doneDir, `${id}.yml`);
      fs.writeFileSync(filePath, `id: ${id}\ntitle: ${id}\n`, 'utf8');
      const ts = Date.now() - (25 - index) * 1_000;
      fs.utimesSync(filePath, ts / 1000, ts / 1000);
    }

    const board = await loadBoardState(root);

    expect(board.done).toHaveLength(20);
    expect(board.done[0]?.id).toBe('task-24');
    expect(board.done[19]?.id).toBe('task-05');
  });
});
