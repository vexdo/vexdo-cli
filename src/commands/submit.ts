import type { Command } from 'commander';

import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { requireGhAvailable } from '../lib/requirements.js';
import { loadState } from '../lib/state.js';
import { submitActiveTask } from '../lib/submit-task.js';

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runSubmit(): Promise<void> {
  try {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      fatalAndExit('Not inside a vexdo project.');
    }

    const config = loadConfig(projectRoot);
    const state = loadState(projectRoot);
    if (!state) {
      fatalAndExit('No active task.');
    }

    await requireGhAvailable();
    await submitActiveTask(projectRoot, config, state);
  } catch (error: unknown) {
    fatalAndExit(error instanceof Error ? error.message : String(error));
  }
}

export function registerSubmitCommand(program: Command): void {
  program.command('submit').description('Create PRs for active task').action(async () => {
    await runSubmit();
  });
}
