import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import { checkCopilotAvailable, CopilotReviewError } from '../lib/copilot.js';
import * as codex from '../lib/codex.js';
import { runCloudReviewLoop } from '../lib/cloud-review-loop.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey, resolveCodexEnvId } from '../lib/requirements.js';
import { createState, hasActiveTask, loadState, saveState, updateStep } from '../lib/state.js';
import { runStepsConcurrently, type StepResult } from '../lib/runner.js';
import { submitActiveTask } from '../lib/submit-task.js';
import { buildInitialStepState, ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';
import type { TaskStep } from '../types/index.js';

export interface StartCommandOptions {
  dryRun?: boolean;
  verbose?: boolean;
  resume?: boolean;
  autoApprove?: boolean;
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
      await checkCopilotAvailable();
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

    const stepResults = await runStepsConcurrently(
      task.steps,
      { maxConcurrent: config.maxConcurrent },
      async (step: TaskStep, stepIndexWithinService: number): Promise<StepResult> => {
        const scopedLogger = logger.withPrefix(`[${step.service}]`);
        const latestState = options.dryRun ? state : loadState(projectRoot);
        const stepState = latestState?.steps.find((item) => item.service === step.service);

        if (!stepState) {
          return { service: step.service, status: 'failed', error: 'step_state_missing' };
        }

        // Skip steps already processed in a previous run
        if (stepIndexWithinService < stepState.currentStepIndex) {
          return { service: step.service, status: 'done', sessionId: stepState.session_id };
        }

        const serviceCfg = config.services.find((service) => service.name === step.service);
        if (!serviceCfg) {
          return { service: step.service, status: 'failed', error: `Unknown service in step: ${step.service}` };
        }

        const serviceRoot = path.resolve(projectRoot, serviceCfg.path);
        const branch = stepState.branch ?? git.getBranchName(task.id, step.service);

        try {
          if (!options.dryRun) {
            if (stepIndexWithinService === 0) {
              // First step for this service: create branch
              if (options.resume && stepState.branch) {
                await git.checkoutBranch(stepState.branch, serviceRoot);
              } else {
                await git.fetchBranch(config.codex.base_branch, serviceRoot);
                await git.createBranch(branch, serviceRoot, config.codex.base_branch);
              }
              await updateStep(projectRoot, task.id, step.service, { status: 'in_progress', branch });
            } else {
              // Subsequent steps: reuse the existing branch
              await git.checkoutBranch(stepState.branch ?? branch, serviceRoot);
            }
          }

          if (options.dryRun) {
            scopedLogger.info(`[dry-run] Would run codex cloud implementation for service ${step.service} (step ${String(stepIndexWithinService + 1)})`);
            return { service: step.service, status: 'done' };
          }

          const envId = resolveCodexEnvId(step.service, serviceCfg.env_id);

          scopedLogger.info(`Submitting step ${String(stepIndexWithinService + 1)} to Codex Cloud...`);
          // Reuse session_id only when resuming the first step of a service
          const canResumeSession = options.resume && stepIndexWithinService === 0 && stepState.session_id !== undefined;
          // For the first step use the base branch; subsequent steps build on the existing working branch
          const codexBranch = stepIndexWithinService === 0 ? config.codex.base_branch : branch;
          const submissionSession = canResumeSession && stepState.session_id
            ? stepState.session_id
            : await codex.submitTask(step.spec, { cwd: serviceRoot, envId, branch: codexBranch });
          await updateStep(projectRoot, task.id, step.service, { session_id: submissionSession });

          const execution = await runCloudReviewLoop({
            taskId: task.id,
            taskTitle: task.title,
            service: step.service,
            spec: step.spec,
            sessionId: submissionSession,
            branch,
            stepState: {
              iteration: 0,
              session_id: submissionSession,
            },
            projectRoot,
            config,
            claude,
            verbose: options.verbose,
            autoApprove: options.autoApprove,
            log: scopedLogger,
            serviceRoot,
            envId,
          });

          await updateStep(projectRoot, task.id, step.service, {
            lastReview: execution.lastReview,
            lastArbiterResult: execution.lastArbiterResult,
            iteration: execution.finalIteration,
            session_id: execution.sessionId,
            currentStepIndex: stepIndexWithinService + 1,
          });

          if (execution.lastArbiterResult.decision === 'escalate') {
            if (!options.autoApprove) {
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

              await updateStep(projectRoot, task.id, step.service, { status: 'escalated' });
              return { service: step.service, status: 'escalated', sessionId: execution.sessionId };
            }

            scopedLogger.warn(
              `Step escalated (auto-approving): ${execution.lastArbiterResult.summary || execution.lastArbiterResult.reasoning}`,
            );
            if (await git.hasUncommittedChanges(serviceRoot)) {
              scopedLogger.info(`Committing and pushing to ${branch}...`);
              await git.stageAll(serviceRoot);
              await git.commit(`chore: auto-approve escalated step [${step.service}]`, serviceRoot);
              await git.push(branch, serviceRoot);
            }
          }

          const stepsForService = task.steps.filter((s) => s.service === step.service).length;
          const isLastStep = stepIndexWithinService === stepsForService - 1;

          if (isLastStep) {
            await updateStep(projectRoot, task.id, step.service, { status: 'done' });
            scopedLogger.success('Review passed — ready for PR');
          } else {
            scopedLogger.success(`Step ${String(stepIndexWithinService + 1)} passed — continuing to next step`);
          }

          return { service: step.service, status: 'done', sessionId: execution.sessionId };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (!options.dryRun) {
            await updateStep(projectRoot, task.id, step.service, { status: 'failed' });
          }
          scopedLogger.error(message);
          if (error instanceof codex.CodexError) {
            if (error.stderr) scopedLogger.error(`stderr: ${error.stderr}`);
            if (error.stdout) scopedLogger.debug(`stdout: ${error.stdout}`);
          } else if (error instanceof CopilotReviewError) {
            if (error.stderr) scopedLogger.error(`stderr: ${error.stderr}`);
            if (error.stdout) scopedLogger.debug(`stdout: ${error.stdout}`);
          }
          return { service: step.service, status: 'failed', error: message };
        }
      },
    );

    if (!options.dryRun) {
      for (const result of stepResults) {
        if (result.status === 'failed' && result.error === 'dependency_failed') {
          await updateStep(projectRoot, task.id, result.service, { status: 'failed' });
        }
      }
    }

    const hasEscalation = stepResults.some((result) => result.status === 'escalated');
    const hasFailure = stepResults.some((result) => result.status === 'failed');

    state = loadState(projectRoot) ?? state;

    if (hasEscalation || hasFailure) {
      state.status = hasEscalation ? 'escalated' : 'blocked';
      if (!options.dryRun) {
        saveState(projectRoot, state);
        const blockedDir = ensureTaskDirectory(projectRoot, 'blocked');
        state.taskPath = moveTaskFileAtomically(state.taskPath, blockedDir);
        saveState(projectRoot, state);
      }
      process.exit(1);
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
    .option('--verbose', 'Enable verbose logs')
    .option('--dry-run', 'Print plan without making changes')
    .option('--resume', 'Resume an existing active task')
    .option('--auto-approve', 'Automatically approve escalated steps and continue')
    .action(async (taskFile: string, options: StartCommandOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runStart(taskFile, { ...options, ...merged });
    });
}
