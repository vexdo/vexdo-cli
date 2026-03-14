import path from 'node:path';

import type { Command } from 'commander';

import { ClaudeClient } from '../lib/claude.js';
import * as codex from '../lib/codex.js';
import { findProjectRoot, loadConfig } from '../lib/config.js';
import * as git from '../lib/git.js';
import * as logger from '../lib/logger.js';
import { requireAnthropicApiKey } from '../lib/requirements.js';
import { createState, hasActiveTask, loadState, saveIterationLog, saveState } from '../lib/state.js';
import { submitActiveTask } from '../lib/submit-task.js';
import { buildInitialStepState, ensureTaskDirectory, loadAndValidateTask, moveTaskFileAtomically } from '../lib/tasks.js';
import type { ArbiterResult, ReviewComment } from '../types/index.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

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
          if (stepState.branch) {
            await git.checkoutBranch(stepState.branch, serviceRoot);
          } else {
            await git.createBranch(branch, serviceRoot);
          }
        } else {
          await git.createBranch(branch, serviceRoot);
        }
      }

      stepState.status = 'in_progress';
      stepState.branch = branch;
      if (!options.dryRun) {
        saveState(projectRoot, state);
      }

      if (options.dryRun) {
        logger.info(`[dry-run] Would run codex cloud implementation for service ${step.service}`);
      } else {
        const submissionSession = stepState.session_id ?? (await codex.submitTask(step.spec, {cwd: serviceRoot}));
        stepState.session_id = submissionSession;
        saveState(projectRoot, state);

        const execution = await runCloudReviewLoop({
          taskId: task.id,
          service: step.service,
          spec: step.spec,
          sessionId: submissionSession,
          stepState,
          projectRoot,
          config,
          claude,
          verbose: options.verbose,
        });

        stepState.lastReviewComments = execution.lastReviewComments;
        stepState.lastArbiterResult = execution.lastArbiterResult;
        stepState.iteration = execution.finalIteration;
        stepState.session_id = execution.sessionId;
      }

      if (stepState.lastArbiterResult?.decision === 'escalate') {
        logger.escalation({
          taskId: task.id,
          service: step.service,
          iteration: stepState.iteration,
          spec: step.spec,
          diff: '',
          reviewComments: stepState.lastReviewComments ?? [],
          arbiterReasoning: stepState.lastArbiterResult.reasoning,
          summary: stepState.lastArbiterResult.summary,
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

async function runCloudReviewLoop(opts: {
  taskId: string;
  service: string;
  spec: string;
  sessionId: string;
  stepState: {iteration: number; session_id?: string};
  projectRoot: string;
  config: ReturnType<typeof loadConfig>;
  claude: ClaudeClient;
  verbose?: boolean;
}): Promise<{sessionId: string; finalIteration: number; lastReviewComments: ReviewComment[]; lastArbiterResult: ArbiterResult}> {
  let sessionId = opts.sessionId;
  let iteration = opts.stepState.iteration;

  for (;;) {
    logger.iteration(iteration + 1, opts.config.review.max_iterations);

    logger.info(`Polling codex cloud session ${sessionId}`);
    const status = await codex.pollStatus(sessionId, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });

    if (status !== 'completed') {
      return {
        sessionId,
        finalIteration: iteration,
        lastReviewComments: [],
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: `Codex Cloud session ended with status '${status}'.`,
          summary: 'Escalated due to codex cloud execution failure.',
        },
      };
    }

    logger.info(`Retrieving diff for session ${sessionId}`);
    const diff = await codex.getDiff(sessionId);

    logger.info(`Requesting reviewer analysis (model: ${opts.config.review.model})`);
    const review = await opts.claude.runReviewer({
      spec: opts.spec,
      diff,
      model: opts.config.review.model,
    });
    logger.reviewSummary(review.comments);

    logger.info(`Requesting arbiter decision (model: ${opts.config.review.model})`);
    const arbiter = await opts.claude.runArbiter({
      spec: opts.spec,
      diff,
      reviewComments: review.comments,
      model: opts.config.review.model,
    });

    saveIterationLog(opts.projectRoot, opts.taskId, opts.service, iteration, {
      diff,
      review,
      arbiter,
    });

    opts.stepState.iteration = iteration;
    opts.stepState.session_id = sessionId;

    if (arbiter.decision === 'submit' || arbiter.decision === 'escalate') {
      return {
        sessionId,
        finalIteration: iteration,
        lastReviewComments: review.comments,
        lastArbiterResult: arbiter,
      };
    }

    if (iteration >= opts.config.review.max_iterations) {
      return {
        sessionId,
        finalIteration: iteration,
        lastReviewComments: review.comments,
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
        lastReviewComments: review.comments,
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: 'Arbiter returned fix decision without feedback_for_codex.',
          summary: 'Escalated because fix instructions were missing.',
        },
      };
    }

    logger.info('Arbiter requested fixes, resuming codex cloud session');
    sessionId = await codex.resumeTask(sessionId, arbiter.feedback_for_codex);
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
