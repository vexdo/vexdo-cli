import fs from 'node:fs';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey } from '../lib/requirements.js';
import { runReviewLoop } from '../lib/review-loop.js';
import { loadState, saveState } from '../lib/state.js';
import { ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';

interface ReviewOptions { dryRun?: boolean; verbose?: boolean }

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runReview(options: ReviewOptions): Promise<void> {
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

    if (!options.dryRun) {
      requireAnthropicApiKey();
    }

    const currentStep = state.steps.find((step) => step.status === 'in_progress' || step.status === 'pending');
    if (!currentStep) {
      fatalAndExit('No in-progress step found in active task.');
    }

    if (!fs.existsSync(state.taskPath)) {
      fatalAndExit(`Task file not found: ${state.taskPath}`);
    }

    const task = loadAndValidateTask(state.taskPath, config);
    const step = task.steps.find((item) => item.service === currentStep.service);
    if (!step) {
      fatalAndExit(`Could not locate task step for service '${currentStep.service}'.`);
    }

    logger.info(`Running review loop for service ${step.service}`);
    const result = await runReviewLoop({
      taskId: task.id,
      task,
      step,
      stepState: currentStep,
      projectRoot,
      config,
      claude: new ClaudeClient(process.env.ANTHROPIC_API_KEY ?? ''),
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
        reviewText: result.lastReview,
        arbiterReasoning: result.lastArbiterResult.reasoning,
        summary: result.lastArbiterResult.summary,
      });

      currentStep.status = 'escalated';
      state.status = 'escalated';

      if (!options.dryRun) {
        saveState(projectRoot, state);
        const blockedDir = ensureTaskDirectory(projectRoot, 'blocked');
        state.taskPath = moveTaskFileAtomically(state.taskPath, blockedDir);
        saveState(projectRoot, state);
      }

      process.exit(1);
    }

    currentStep.status = 'done';
    if (!options.dryRun) {
      saveState(projectRoot, state);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    fatalAndExit(message);
  }
}

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run review loop for the current step')
    .option('--verbose', 'Enable verbose logs')
    .option('--dry-run', 'Print plan without making changes')
    .action(async (options: ReviewOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runReview({ ...options, ...merged });
    });
}
