import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

export interface TaskSummary {
  id: string;
  title: string;
  path: string;
  blocked?: boolean;
}

export interface BoardState {
  backlog: TaskSummary[];
  in_progress: TaskSummary[];
  review: TaskSummary[];
  done: TaskSummary[];
  blocked: TaskSummary[];
}

interface ParsedTask {
  id?: string;
  title?: string;
}

function parseTaskYaml(raw: string): ParsedTask {
  try {
    const parsed: unknown = parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    return {
      id: typeof obj.id === 'string' ? obj.id : undefined,
      title: typeof obj.title === 'string' ? obj.title : undefined,
    };
  } catch {
    return {};
  }
}

async function listTaskFiles(directory: string): Promise<string[]> {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')))
    .map((entry) => path.join(directory, entry.name));
}

async function readTaskSummary(filePath: string): Promise<TaskSummary> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const parsed = parseTaskYaml(raw);
  const fallbackId = path.basename(filePath).replace(/\.ya?ml$/i, '');

  return {
    id: parsed.id ?? fallbackId,
    title: parsed.title ?? fallbackId,
    path: filePath,
  };
}

async function loadColumn(projectRoot: string, columnDir: string): Promise<TaskSummary[]> {
  const directory = path.join(projectRoot, 'tasks', columnDir);
  const files = await listTaskFiles(directory);
  const tasks = await Promise.all(files.map((filePath) => readTaskSummary(filePath)));
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadBoardState(projectRoot: string): Promise<BoardState> {
  const [backlog, inProgress, review, blocked, doneFiles] = await Promise.all([
    loadColumn(projectRoot, 'backlog'),
    loadColumn(projectRoot, 'in_progress'),
    loadColumn(projectRoot, 'review'),
    loadColumn(projectRoot, 'blocked'),
    listTaskFiles(path.join(projectRoot, 'tasks', 'done')),
  ]);

  const doneWithStats = await Promise.all(
    doneFiles.map(async (filePath) => ({
      filePath,
      stat: await fs.promises.stat(filePath),
    })),
  );

  doneWithStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const done = await Promise.all(doneWithStats.slice(0, 20).map((item) => readTaskSummary(item.filePath)));

  return {
    backlog,
    in_progress: inProgress,
    review,
    done,
    blocked: blocked.map((task) => ({ ...task, blocked: true })),
  };
}
