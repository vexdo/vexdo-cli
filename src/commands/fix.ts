import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import * as codex from '../lib/codex.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey } from '../lib/requirements.js';
import { runReviewLoop } from '../lib/review-loop.js';
import { loadState, saveState } from '../lib/state.js';
import { ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';

interface FixOptions { dryRun?: boolean; verbose?: boolean }

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runFix(feedback: string, options: FixOptions): Promise<void> {
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
      await codex.checkCodexAvailable();
    }

    const currentStep = state.steps.find((step) => step.status === 'in_progress' || step.status === 'pending');
    if (!currentStep) {
      fatalAndExit('No in-progress step found in active task.');
    }

    const task = loadAndValidateTask(state.taskPath, config);
    const step = task.steps.find((item) => item.service === currentStep.service);
    if (!step) {
      fatalAndExit(`Could not locate task step for service '${currentStep.service}'.`);
    }

    if (!options.dryRun) {
      const serviceConfig = config.services.find((service) => service.name === currentStep.service);
      if (!serviceConfig) {
        fatalAndExit(`Unknown service in step: ${currentStep.service}`);
      }

      await codex.exec({
        spec: feedback,
        model: config.codex.model,
        cwd: path.resolve(projectRoot, serviceConfig.path),
        verbose: options.verbose,
      });
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
    fatalAndExit(error instanceof Error ? error.message : String(error));
  }
}

export function registerFixCommand(program: Command): void {
  program
    .command('fix')
    .description('Provide feedback to codex and rerun review')
    .argument('<feedback>')
    .option('--verbose', 'Enable verbose logs')
    .option('--dry-run', 'Print plan without making changes')
    .action(async (feedback: string, options: FixOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runFix(feedback, { ...options, ...merged });
    });
}
