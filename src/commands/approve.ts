import path from 'node:path';

import type { Command } from 'commander';

import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';
import { loadState, saveState, updateStep } from '../lib/state.js';

interface ApproveOptions {
  service?: string;
  message?: string;
}

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runApprove(options: ApproveOptions): Promise<void> {
  try {
    const projectRoot = findProjectRoot();
    if (!projectRoot) fatalAndExit('Not inside a vexdo project.');

    const config = loadConfig(projectRoot);

    const state = loadState(projectRoot);
    if (!state) fatalAndExit('No task state found. Run vexdo start first.');

    const task = loadAndValidateTask(state.taskPath, config);

    const escalatedSteps = state.steps.filter((s) => s.status === 'escalated');
    if (escalatedSteps.length === 0) {
      fatalAndExit('No escalated steps found. Nothing to approve.');
    }

    let targetSteps = escalatedSteps;
    if (options.service) {
      const found = escalatedSteps.find((s) => s.service === options.service);
      if (!found) {
        fatalAndExit(
          `Service '${options.service}' is not in escalated state. ` +
          `Escalated services: ${escalatedSteps.map((s) => s.service).join(', ')}.`,
        );
      }
      targetSteps = [found];
    } else if (escalatedSteps.length > 1) {
      fatalAndExit(
        `Multiple escalated services: ${escalatedSteps.map((s) => s.service).join(', ')}. ` +
        `Use --service <name> to specify which one to approve.`,
      );
    }

    for (const stepState of targetSteps) {
      const scopedLogger = logger.withPrefix(`[${stepState.service}]`);
      const serviceCfg = config.services.find((s) => s.name === stepState.service);
      if (!serviceCfg) fatalAndExit(`Unknown service: ${stepState.service}`);

      const serviceRoot = path.resolve(projectRoot, serviceCfg.path);
      const branch = stepState.branch ?? git.getBranchName(task.id, stepState.service);

      await git.checkoutBranch(branch, serviceRoot);

      if (await git.hasUncommittedChanges(serviceRoot)) {
        const commitMessage = options.message ?? `chore: manual approval [${stepState.service}]`;
        scopedLogger.info(`Committing and pushing to ${branch}...`);
        await git.stageAll(serviceRoot);
        await git.commit(commitMessage, serviceRoot);
        await git.push(branch, serviceRoot);
      } else {
        scopedLogger.info('Branch is clean — nothing to commit.');
      }

      await updateStep(projectRoot, task.id, stepState.service, { status: 'done' });
      scopedLogger.success('Step approved.');
    }

    // Restore task to in_progress so --resume can continue
    const latestState = loadState(projectRoot);
    if (!latestState) {
      throw new Error('State was unexpectedly cleared during approval.');
    }
    latestState.status = 'in_progress';
    const inProgressDir = ensureTaskDirectory(projectRoot, 'in_progress');
    latestState.taskPath = moveTaskFileAtomically(latestState.taskPath, inProgressDir);
    saveState(projectRoot, latestState);

    logger.success("Approved. Run 'vexdo start --resume' to continue with remaining steps.");
  } catch (error: unknown) {
    fatalAndExit(error instanceof Error ? error.message : String(error));
  }
}

export function registerApproveCommand(program: Command): void {
  program
    .command('approve')
    .description('Manually approve an escalated step and continue the task')
    .option('--service <name>', 'Service to approve (required when multiple services are escalated)')
    .option('--message <msg>', 'Commit message for uncommitted changes on the branch')
    .action(async (options: ApproveOptions) => {
      await runApprove(options);
    });
}
