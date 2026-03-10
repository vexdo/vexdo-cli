import fs from 'node:fs';
import path from 'node:path';

import type { ArbiterResult, ReviewResult, StepState, VexdoState } from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function getStateDir(projectRoot: string): string {
  return path.join(projectRoot, '.vexdo');
}

export function getStatePath(projectRoot: string): string {
  return path.join(getStateDir(projectRoot), 'state.json');
}

export function getLogsDir(projectRoot: string, taskId: string): string {
  return path.join(getStateDir(projectRoot), 'logs', taskId);
}

export function ensureLogsDir(projectRoot: string, taskId: string): string {
  const logsDir = getLogsDir(projectRoot, taskId);
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function loadState(projectRoot: string): VexdoState | null {
  const statePath = getStatePath(projectRoot);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  try {
    return JSON.parse(raw) as VexdoState;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Corrupt state file at ${statePath}: ${message}`);
  }
}

export function saveState(projectRoot: string, state: VexdoState): void {
  const stateDir = getStateDir(projectRoot);
  fs.mkdirSync(stateDir, { recursive: true });

  const nextState: VexdoState = {
    ...state,
    updatedAt: nowIso(),
  };

  fs.writeFileSync(getStatePath(projectRoot), JSON.stringify(nextState, null, 2) + '\n', 'utf8');
}

export function clearState(projectRoot: string): void {
  const statePath = getStatePath(projectRoot);
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath);
  }
}

export function hasActiveTask(projectRoot: string): boolean {
  const state = loadState(projectRoot);
  return state?.status === 'in_progress' || state?.status === 'review';
}

export function createState(
  taskId: string,
  taskTitle: string,
  taskPath: string,
  steps: StepState[],
): VexdoState {
  const timestamp = nowIso();
  return {
    taskId,
    taskTitle,
    taskPath,
    status: 'in_progress',
    steps: [...steps],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateStep(
  state: VexdoState,
  service: string,
  updates: Partial<Omit<StepState, 'service'>>,
): VexdoState {
  return {
    ...state,
    steps: state.steps.map((step) => {
      if (step.service !== service) {
        return step;
      }
      return {
        ...step,
        ...updates,
      };
    }),
    updatedAt: nowIso(),
  };
}

export function saveIterationLog(
  projectRoot: string,
  taskId: string,
  service: string,
  iteration: number,
  payload: { diff: string; review: ReviewResult; arbiter: ArbiterResult },
): void {
  const logsDir = ensureLogsDir(projectRoot, taskId);
  const base = `${service}-iteration-${String(iteration)}`;
  fs.writeFileSync(path.join(logsDir, `${base}-diff.txt`), payload.diff, 'utf8');
  fs.writeFileSync(path.join(logsDir, `${base}-review.json`), JSON.stringify(payload.review, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(logsDir, `${base}-arbiter.json`),
    JSON.stringify(payload.arbiter, null, 2) + '\n',
    'utf8',
  );
}
