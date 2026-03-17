import fs from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import { runCloudReviewLoop } from '../lib/cloud-review-loop.js';
import { checkCopilotAvailable, CopilotReviewError } from '../lib/copilot.js';
import * as codex from '../lib/codex.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey, resolveCodexEnvId } from '../lib/requirements.js';
import { ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';
import { loadState, saveState, updateStep } from '../lib/state.js';

interface FixOptions { dryRun?: boolean; verbose?: boolean }

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runFix(taskFile: string, feedback: string | undefined, options: FixOptions): Promise<void> {
  try {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
      fatalAndExit('Not inside a vexdo project.');
    }

    const config = loadConfig(projectRoot);
    const taskPath = path.resolve(taskFile);
    const task = loadAndValidateTask(taskPath, config);

    const state = loadState(projectRoot);
    if (!state) {
      fatalAndExit('No task state found. Run vexdo start first.');
    }
    if (state.taskId !== task.id) {
      fatalAndExit(`Active task is '${state.taskId}', but task file is '${task.id}'.`);
    }

    if (!options.dryRun) {
      requireAnthropicApiKey();
      await codex.checkCodexAvailable();
      await checkCopilotAvailable();
    }

    const claude = new ClaudeClient(process.env.ANTHROPIC_API_KEY ?? '');

    for (const step of task.steps) {
      const scopedLogger = logger.withPrefix(`[${step.service}]`);
      const stepState = state.steps.find((s) => s.service === step.service);

      if (!stepState?.branch) {
        scopedLogger.warn(`No branch found for service ${step.service}, skipping.`);
        continue;
      }

      const serviceCfg = config.services.find((s) => s.name === step.service);
      if (!serviceCfg) {
        fatalAndExit(`Unknown service: ${step.service}`);
      }

      const serviceRoot = path.resolve(projectRoot, serviceCfg.path);
      const { branch } = stepState;

      if (options.dryRun) {
        scopedLogger.info(`[dry-run] Would resubmit to Codex Cloud on branch ${branch}`);
        continue;
      }

      try {
        await git.checkoutBranch(branch, serviceRoot);

        const envId = resolveCodexEnvId(step.service, serviceCfg.env_id);

        let spec = step.spec;
        if (feedback) {
          scopedLogger.info('Expanding feedback with Claude...');
          spec = await claude.expandFeedback({spec: step.spec, feedback, model: config.review.model});
          scopedLogger.debug(`Expanded spec:\n${spec}`);
        }

        scopedLogger.info(`Submitting to Codex Cloud on branch ${branch}...`);
        const sessionId = await codex.submitTask(spec, {cwd: serviceRoot, envId, branch});

        await updateStep(projectRoot, task.id, step.service, {
          status: 'in_progress',
          session_id: sessionId,
          iteration: 0,
        });

        const execution = await runCloudReviewLoop({
          taskId: task.id,
          taskTitle: task.title,
          service: step.service,
          spec,
          sessionId,
          branch,
          stepState: {iteration: 0, session_id: sessionId},
          projectRoot,
          config,
          claude,
          verbose: options.verbose,
          log: scopedLogger,
          serviceRoot,
          envId,
        });

        await updateStep(projectRoot, task.id, step.service, {
          lastReview: execution.lastReview,
          lastArbiterResult: execution.lastArbiterResult,
          iteration: execution.finalIteration,
          session_id: execution.sessionId,
        });

        if (execution.lastArbiterResult.decision === 'escalate') {
          logger.escalation({
            taskId: task.id,
            service: step.service,
            iteration: execution.finalIteration,
            spec: step.spec,
            diff: '',
            reviewText: execution.lastReview,
            arbiterReasoning: execution.lastArbiterResult.reasoning,
            summary: execution.lastArbiterResult.summary,
          });
          await updateStep(projectRoot, task.id, step.service, {status: 'escalated'});
          const latestState = loadState(projectRoot) ?? state;
          latestState.status = 'escalated';
          const blockedDir = ensureTaskDirectory(projectRoot, 'blocked');
          if (fs.existsSync(latestState.taskPath)) {
            latestState.taskPath = moveTaskFileAtomically(latestState.taskPath, blockedDir);
          }
          saveState(projectRoot, latestState);
          process.exit(1);
        }

        await updateStep(projectRoot, task.id, step.service, {status: 'done'});
        scopedLogger.success('Review passed — ready for PR');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await updateStep(projectRoot, task.id, step.service, {status: 'failed'});
        scopedLogger.error(message);
        if (error instanceof codex.CodexError) {
          if (error.stderr) scopedLogger.error(`stderr: ${error.stderr}`);
          if (error.stdout) scopedLogger.debug(`stdout: ${error.stdout}`);
        } else if (error instanceof CopilotReviewError) {
          if (error.stderr) scopedLogger.error(`stderr: ${error.stderr}`);
          if (error.stdout) scopedLogger.debug(`stdout: ${error.stdout}`);
        }
        process.exit(1);
      }
    }

    logger.success("Fix complete. Run 'vexdo submit' to update the PR.");
  } catch (error: unknown) {
    fatalAndExit(error instanceof Error ? error.message : String(error));
  }
}

export function registerFixCommand(program: Command): void {
  program
    .command('fix')
    .description('Resubmit a task to Codex Cloud and rerun review on the existing branch')
    .argument('<task-file>', 'Path to the task YAML file')
    .argument('[feedback]', 'Short description of what to fix (expanded by Claude before sending to Codex)')
    .option('--verbose', 'Enable verbose logs')
    .option('--dry-run', 'Print plan without making changes')
    .action(async (taskFile: string, feedback: string | undefined, options: FixOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runFix(taskFile, feedback, {...options, ...merged});
    });
}
