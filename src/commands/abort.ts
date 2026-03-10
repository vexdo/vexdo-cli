import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Command } from 'commander';

import { findProjectRoot } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { clearState, loadState } from '../lib/state.js';
import { ensureTaskDirectory, moveTaskFileAtomically } from '../lib/tasks.js';

export type AbortOptions = { force?: boolean };

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

async function promptConfirmation(taskId: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Abort task ${taskId}? Branches will be kept. [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export async function runAbort(options: AbortOptions): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    fatalAndExit('Not inside a vexdo project.');
  }

  const state = loadState(projectRoot);
  if (!state) {
    fatalAndExit('No active task.');
  }

  if (!options.force) {
    const confirmed = await promptConfirmation(state.taskId);
    if (!confirmed) {
      logger.info('Abort cancelled.');
      return;
    }
  }

  const inProgressDir = path.join(projectRoot, 'tasks', 'in_progress');
  if (state.taskPath.startsWith(inProgressDir) && fs.existsSync(state.taskPath)) {
    const backlogDir = ensureTaskDirectory(projectRoot, 'backlog');
    moveTaskFileAtomically(state.taskPath, backlogDir);
  }

  clearState(projectRoot);
  logger.info('Task aborted. Branches preserved for manual review.');
}

export function registerAbortCommand(program: Command): void {
  program
    .command('abort')
    .description('Abort active task')
    .option('--force', 'Skip confirmation prompt')
    .action(async (options: AbortOptions) => {
      await runAbort(options);
    });
}
