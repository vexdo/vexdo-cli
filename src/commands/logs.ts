import fs from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { findProjectRoot } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { getLogsDir, getStateDir, loadState } from '../lib/state.js';

interface LogsOptions { full?: boolean }

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export function runLogs(taskIdArg?: string, options?: LogsOptions): void {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    fatalAndExit('Not inside a vexdo project.');
  }

  const state = loadState(projectRoot);
  const taskId = taskIdArg ?? state?.taskId;

  if (!taskId) {
    const base = path.join(getStateDir(projectRoot), 'logs');
    if (!fs.existsSync(base)) {
      logger.info('No logs available.');
      return;
    }

    const tasks = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const dir of tasks) {
      logger.info(dir.name);
    }
    return;
  }

  const logsDir = getLogsDir(projectRoot, taskId);
  if (!fs.existsSync(logsDir)) {
    fatalAndExit(`No logs found for task '${taskId}'.`);
  }

  const files = fs.readdirSync(logsDir).filter((name) => name.endsWith('-arbiter.json'));
  for (const arbiterFile of files) {
    const base = arbiterFile.replace(/-arbiter\.json$/, '');
    const arbiterPath = path.join(logsDir, `${base}-arbiter.json`);
    const reviewPath = path.join(logsDir, `${base}-review.json`);
    const diffPath = path.join(logsDir, `${base}-diff.txt`);

    const arbiter = JSON.parse(fs.readFileSync(arbiterPath, 'utf8')) as { decision: string; summary: string };
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as { comments?: unknown[] };

    logger.info(`${base}: decision=${arbiter.decision}, comments=${String(review.comments?.length ?? 0)}, summary=${arbiter.summary}`);

    if (options?.full) {
      console.log(fs.readFileSync(diffPath, 'utf8'));
      console.log(JSON.stringify(review, null, 2));
      console.log(JSON.stringify(arbiter, null, 2));
    }
  }
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Show iteration logs')
    .argument('[task-id]')
    .option('--full', 'Print full diff and comments')
    .action((taskId?: string, options?: LogsOptions) => {
      runLogs(taskId, options);
    });
}
