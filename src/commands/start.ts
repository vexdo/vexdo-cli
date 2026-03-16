import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import { checkCopilotAvailable, CopilotReviewError, runCopilotReview, type ReviewIteration } from '../lib/copilot.js';
import * as codex from '../lib/codex.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey, resolveCodexEnvId } from '../lib/requirements.js';
import { createState, hasActiveTask, loadState, saveIterationLog, saveState, updateStep } from '../lib/state.js';
import { runStepsConcurrently, type StepResult } from '../lib/runner.js';
import { submitActiveTask } from '../lib/submit-task.js';
import { buildInitialStepState, ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';
import type { ArbiterResult, TaskStep } from '../types/index.js';

const POLL_INTERVAL_MS = 2 * 60_000;
const POLL_TIMEOUT_MS = 30 * 60_000;

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
      async (step: TaskStep): Promise<StepResult> => {
        const scopedLogger = logger.withPrefix(`[${step.service}]`);
        const latestState = options.dryRun ? state : loadState(projectRoot);
        const stepState = latestState?.steps.find((item) => item.service === step.service);

        if (!stepState) {
          return { service: step.service, status: 'failed', error: 'step_state_missing' };
        }

        if (stepState.status === 'done') {
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
            if (options.resume) {
              if (stepState.branch) {
                await git.checkoutBranch(stepState.branch, serviceRoot);
              } else {
                await git.createBranch(branch, serviceRoot, config.codex.base_branch);
              }
            } else {
              await git.fetchBranch(config.codex.base_branch, serviceRoot);
              await git.createBranch(branch, serviceRoot, config.codex.base_branch);
            }

            await updateStep(projectRoot, task.id, step.service, {
              status: 'in_progress',
              branch,
            });
          }

          if (options.dryRun) {
            scopedLogger.info(`[dry-run] Would run codex cloud implementation for service ${step.service}`);
            return { service: step.service, status: 'done' };
          }

          const envId = options.dryRun ? undefined : resolveCodexEnvId(step.service, serviceCfg.env_id);

          scopedLogger.info('Submitting to Codex Cloud...');
          const submissionSession = stepState.session_id ?? (await codex.submitTask(step.spec, { cwd: serviceRoot, envId, branch: config.codex.base_branch }));
          await updateStep(projectRoot, task.id, step.service, { session_id: submissionSession });

          const execution = await runCloudReviewLoop({
            taskId: task.id,
            taskTitle: task.title,
            service: step.service,
            spec: step.spec,
            sessionId: submissionSession,
            branch,
            stepState: {
              iteration: stepState.iteration,
              session_id: submissionSession,
            },
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

            await updateStep(projectRoot, task.id, step.service, { status: 'escalated' });
            return { service: step.service, status: 'escalated', sessionId: execution.sessionId };
          }

          await updateStep(projectRoot, task.id, step.service, { status: 'done' });
          scopedLogger.success('Review passed — ready for PR');
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

async function runCloudReviewLoop(opts: {
  taskId: string;
  taskTitle: string;
  service: string;
  spec: string;
  sessionId: string;
  branch: string;
  stepState: { iteration: number; session_id?: string };
  projectRoot: string;
  config: ReturnType<typeof loadConfig>;
  claude: ClaudeClient;
  verbose?: boolean;
  log: logger.Logger;
  serviceRoot: string;
  envId?: string;
}): Promise<{ sessionId: string; finalIteration: number; lastReview: string; lastArbiterResult: ArbiterResult }> {
  let sessionId = opts.sessionId;
  let iteration = opts.stepState.iteration;
  const history: ReviewIteration[] = [];

  for (;;) {
    opts.log.iteration(iteration + 1, opts.config.review.max_iterations);

    opts.log.info(`Polling codex cloud session ${sessionId}. To check manually: codex cloud status ${sessionId}`);
    const status = await codex.pollStatus(sessionId, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });

    if (status !== 'completed') {
      return {
        sessionId,
        finalIteration: iteration,
        lastReview: '',
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: `Codex Cloud session ended with status '${status}'.`,
          summary: 'Escalated due to codex cloud execution failure.',
        },
      };
    }

    opts.log.success('Codex task completed');
    opts.log.info(`Retrieving diff for session ${sessionId}`);
    const diff = await codex.getDiff(sessionId, {cwd: opts.serviceRoot});

    const changedFiles = diff
      .split('\n')
      .filter((line) => line.startsWith('diff --git '))
      .map((line) => line.replace(/^diff --git a\/\S+ b\//, ''));
    opts.log.info(`Changed files (${String(changedFiles.length)}): ${changedFiles.join(', ')}`);
    opts.log.debug(diff);

    opts.log.info(`Running review (iteration ${String(iteration + 1)})...`);

    const reviewText = await runCopilotReview(opts.spec, diff, {
      cwd: opts.serviceRoot,
      history: history.length > 0 ? history : undefined,
      onChunk: (chunk) => opts.log.debug(chunk.trimEnd()),
      onRawOutput: (_, stderr) => {
        if (stderr) opts.log.debug(`copilot stderr:\n${stderr}`);
      },
    });

    opts.log.debug(`Review:\n${reviewText}`);

    opts.log.info(`Requesting arbiter decision (model: ${opts.config.review.model})`);
    const arbiter = await opts.claude.runArbiter({
      spec: opts.spec,
      diff,
      reviewText,
      model: opts.config.review.model,
    });

    saveIterationLog(opts.projectRoot, opts.taskId, opts.service, iteration, {
      diff,
      review: reviewText,
      arbiter,
    });

    opts.stepState.iteration = iteration;
    opts.stepState.session_id = sessionId;

    if (arbiter.decision === 'escalate') {
      return {
        sessionId,
        finalIteration: iteration,
        lastReview: reviewText,
        lastArbiterResult: arbiter,
      };
    }

    // Apply, commit and push for both submit and fix — branch is now up to date
    opts.log.info(`Applying diff and pushing to ${opts.branch}...`);
    await codex.applyDiff(sessionId, {cwd: opts.serviceRoot});
    await git.commitAll(`vexdo: iteration ${String(iteration + 1)}`, opts.serviceRoot);
    await git.push(opts.branch, opts.serviceRoot);

    if (arbiter.decision === 'submit') {
      return {
        sessionId,
        finalIteration: iteration,
        lastReview: reviewText,
        lastArbiterResult: arbiter,
      };
    }

    if (iteration + 1 >= opts.config.review.max_iterations) {
      return {
        sessionId,
        finalIteration: iteration,
        lastReview: reviewText,
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: 'Max review iterations reached while arbiter still requested fixes.',
          summary: 'Escalated because maximum iterations were exhausted.',
        },
      };
    }

    if (!arbiter.feedback_for_codex) {
      return {
        sessionId,
        finalIteration: iteration,
        lastReview: reviewText,
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: 'Arbiter returned fix decision without feedback_for_codex.',
          summary: 'Escalated because fix instructions were missing.',
        },
      };
    }

    history.push({review: reviewText, feedbackSentToCodex: arbiter.feedback_for_codex});
    opts.log.warn(`Review requested fixes (iteration ${String(iteration + 1)}/${String(opts.config.review.max_iterations)})`);
    sessionId = await codex.resumeTask(opts.spec, arbiter.feedback_for_codex, {
      cwd: opts.serviceRoot,
      envId: opts.envId,
      branch: opts.branch,
      taskTitle: opts.taskTitle,
      iteration: iteration + 1,
    });
    opts.stepState.session_id = sessionId;
    iteration += 1;
    opts.stepState.iteration = iteration;
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
    .action(async (taskFile: string, options: StartCommandOptions, command: Command) => {
      const merged = command.optsWithGlobals();
      await runStart(taskFile, { ...options, ...merged });
    });
}
