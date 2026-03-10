import type { Command } from 'commander';

import { findProjectRoot } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { loadState } from '../lib/state.js';

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

function formatElapsed(startedAt: string): string {
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(elapsedMs / 1000 / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes % 60)}m`;
  }
  return `${String(minutes)}m`;
}

export function runStatus(): void {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    fatalAndExit('Not inside a vexdo project.');
  }

  const state = loadState(projectRoot);
  if (!state) {
    fatalAndExit('No active task.');
  }

  logger.info(`Task: ${state.taskId} — ${state.taskTitle}`);
  logger.info(`Status: ${state.status}`);
  console.log('service | status | iteration | branch');
  for (const step of state.steps) {
    console.log(`${step.service} | ${step.status} | ${String(step.iteration)} | ${step.branch ?? '-'}`);
  }

  const inProgress = state.steps.find((step) => step.status === 'in_progress');
  if (inProgress?.lastArbiterResult?.summary) {
    logger.info(`Last arbiter summary: ${inProgress.lastArbiterResult.summary}`);
  }

  logger.info(`Elapsed: ${formatElapsed(state.startedAt)}`);
}

export function registerStatusCommand(program: Command): void {
  program.command('status').description('Print active task status').action(() => {
    runStatus();
  });
}
