import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import * as codex from '../lib/codex.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey } from '../lib/requirements.js';
import { runReviewLoop } from '../lib/review-loop.js';
import { createState, hasActiveTask, loadState, saveState } from '../lib/state.js';
import { submitActiveTask } from '../lib/submit-task.js';
import { buildInitialStepState, ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';

export interface StartCommandOptions {
  dryRun?: boolean;
  verbose?: boolean;
  resume?: boolean;
}

function fatalAndExit(message: string, hint?: string): never {
  logger.fatal(message, hint);
  process.exit(1);
}

export async function runStart(taskFile: string, options: StartCommandOptions): Promise<void> {
  try {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      fatalAndExit('Not inside a vexdo project. Could not find .vexdo.yml.');
    }

    const config = loadConfig(projectRoot);
    const taskPath = path.resolve(taskFile);
    const task = loadAndValidateTask(taskPath, config);

    if (hasActiveTask(projectRoot) && !options.resume) {
      fatalAndExit('An active task already exists.', "Use --resume to continue or 'vexdo abort' to cancel.");
    }

    if (!options.dryRun) {
      requireAnthropicApiKey();
      await codex.checkCodexAvailable();
    }

    let state = loadState(projectRoot);

    if (!options.resume) {
      let taskPathInProgress = taskPath;
      if (!options.dryRun) {
        const inProgressDir = ensureTaskDirectory(projectRoot, 'in_progress');
        taskPathInProgress = moveTaskFileAtomically(taskPath, inProgressDir);
      }

      state = createState(task.id, task.title, taskPathInProgress, buildInitialStepState(task));
      if (!options.dryRun) {
        saveState(projectRoot, state);
      }
    }

    if (!state) {
      fatalAndExit('No resumable task state found.');
    }

    const claude = new ClaudeClient(process.env.ANTHROPIC_API_KEY ?? '');
    const total = task.steps.length;

    for (let i = 0; i < task.steps.length; i += 1) {
      const step = task.steps[i];
      const stepState = state.steps[i];
      if (!step || !stepState) {
        continue;
      }

      if (stepState.status === 'done') {
        continue;
      }

      if (step.depends_on && step.depends_on.length > 0) {
        for (const depService of step.depends_on) {
          const depState = state.steps.find((item) => item.service === depService);
          if (depState?.status !== 'done') {
            fatalAndExit(`Step dependency '${depService}' for service '${step.service}' is not done.`);
          }
        }
      }

      logger.step(i + 1, total, `${step.service}: ${task.title}`);

      const serviceCfg = config.services.find((service) => service.name === step.service);
      if (!serviceCfg) {
        fatalAndExit(`Unknown service in step: ${step.service}`);
      }

      const serviceRoot = path.resolve(projectRoot, serviceCfg.path);
      const branch = git.getBranchName(task.id, step.service);

      if (!options.dryRun) {
        if (options.resume) {
          await git.checkoutBranch(stepState.branch ?? branch, serviceRoot);
        } else {
          await git.createBranch(branch, serviceRoot);
        }
      }

      stepState.status = 'in_progress';
      stepState.branch = branch;
      if (!options.dryRun) {
        saveState(projectRoot, state);
      }

      if (!options.resume && !options.dryRun) {
        await codex.exec({
          spec: step.spec,
          model: config.codex.model,
          cwd: serviceRoot,
          verbose: options.verbose,
        });
      } else if (options.dryRun) {
        logger.info(`[dry-run] Would run codex for service ${step.service}`);
      }

      const result = await runReviewLoop({
        taskId: task.id,
        task,
        step,
        stepState,
        projectRoot,
        config,
        claude,
        dryRun: options.dryRun,
        verbose: options.verbose,
      });

      if (result.decision === 'escalate') {
        logger.escalation({
          taskId: task.id,
          service: step.service,
          iteration: result.finalIteration,
          spec: step.spec,
          diff: '',
          reviewComments: result.lastReviewComments,
          arbiterReasoning: result.lastArbiterResult.reasoning,
          summary: result.lastArbiterResult.summary,
        });

        stepState.status = 'escalated';
        state.status = 'escalated';

        if (!options.dryRun) {
          saveState(projectRoot, state);
          const blockedDir = ensureTaskDirectory(projectRoot, 'blocked');
          state.taskPath = moveTaskFileAtomically(state.taskPath, blockedDir);
          saveState(projectRoot, state);
        }

        process.exit(1);
      }

      stepState.status = 'done';
      if (!options.dryRun) {
        saveState(projectRoot, state);
      }
    }

    state.status = 'review';
    if (!options.dryRun) {
      const reviewDir = ensureTaskDirectory(projectRoot, 'review');
      state.taskPath = moveTaskFileAtomically(state.taskPath, reviewDir);
      saveState(projectRoot, state);
    }

    if (config.review.auto_submit && !options.dryRun) {
      await submitActiveTask(projectRoot, config, state);
      return;
    }

    logger.success("Task ready for PR. Run 'vexdo submit' to create PR.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    fatalAndExit(message);
  }
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start a task from a YAML file')
    .argument('<task-file>')
    .option('--resume', 'Resume an existing active task')
    .action(async (taskFile: string, options: StartCommandOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runStart(taskFile, { ...options, ...merged });
    });
}
