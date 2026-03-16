import path from 'node:path';

import * as codex from './codex.js';
import type { ClaudeClient } from './claude.js';
import { runCopilotReview } from './copilot.js';
import * as git from './git.js';
import * as logger from './logger.js';
import * as state from './state.js';
import type {
  ArbiterResult,
  ReviewComment,
  StepState,
  Task,
  TaskStep,
  VexdoConfig,
} from '../types/index.js';

export interface ReviewLoopOptions {
  taskId: string;
  task: Task;
  step: TaskStep;
  stepState: StepState;
  projectRoot: string;
  config: VexdoConfig;
  claude: ClaudeClient;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface ReviewLoopResult {
  decision: 'submit' | 'escalate';
  finalIteration: number;
  lastReviewComments: ReviewComment[];
  lastArbiterResult: ArbiterResult;
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${String(seconds)}s`;
}

export async function runReviewLoop(opts: ReviewLoopOptions): Promise<ReviewLoopResult> {
  if (opts.dryRun) {
    logger.info(`[dry-run] Would run review loop for service ${opts.step.service}`);
    return {
      decision: 'submit',
      finalIteration: opts.stepState.iteration,
      lastReviewComments: [],
      lastArbiterResult: {
        decision: 'submit',
        reasoning: 'Dry run: skipped reviewer and arbiter calls.',
        summary: 'Dry run mode; submitting without external calls.',
      },
    };
  }

  const serviceConfig = opts.config.services.find((service) => service.name === opts.step.service);
  if (!serviceConfig) {
    throw new Error(`Unknown service in step: ${opts.step.service}`);
  }

  const serviceRoot = path.resolve(opts.projectRoot, serviceConfig.path);
  let iteration = opts.stepState.iteration;

  for (;;) {
    logger.iteration(iteration + 1, opts.config.review.max_iterations);
    logger.info(`Collecting git diff for service ${opts.step.service}`);

    const diff = await git.getDiff(serviceRoot);
    if (opts.verbose) {
      logger.info(`Diff collected (${String(diff.length)} chars)`);
    }
    if (!diff.trim()) {
      return {
        decision: 'submit',
        finalIteration: iteration,
        lastReviewComments: [],
        lastArbiterResult: {
          decision: 'submit',
          reasoning: 'No changes in git diff for service directory.',
          summary: 'No diff detected, nothing to review.',
        },
      };
    }

    logger.info(`Requesting reviewer analysis (model: ${opts.config.review.model})`);
    const reviewerStartedAt = Date.now();
    const reviewerHeartbeat = opts.verbose
      ? setInterval(() => {
          logger.info(`Waiting for reviewer response (${formatElapsed(reviewerStartedAt)})`);
        }, 15_000)
      : null;
    const comments = await runCopilotReview(opts.step.spec, { cwd: serviceRoot }).finally(() => {
        if (reviewerHeartbeat) {
          clearInterval(reviewerHeartbeat);
        }
      });
    logger.info(`Reviewer response received in ${formatElapsed(reviewerStartedAt)}`);

    const review = { comments };
    logger.reviewSummary(review.comments);

    logger.info(`Requesting arbiter decision (model: ${opts.config.review.model})`);
    const arbiterStartedAt = Date.now();
    const arbiterHeartbeat = opts.verbose
      ? setInterval(() => {
          logger.info(`Waiting for arbiter response (${formatElapsed(arbiterStartedAt)})`);
        }, 15_000)
      : null;
    const arbiter = await opts.claude
      .runArbiter({
        spec: opts.step.spec,
        diff,
        reviewComments: review.comments,
        model: opts.config.review.model,
      })
      .finally(() => {
        if (arbiterHeartbeat) {
          clearInterval(arbiterHeartbeat);
        }
      });
    logger.info(`Arbiter response received in ${formatElapsed(arbiterStartedAt)}`);
    logger.info(`Arbiter decision: ${arbiter.decision} (${arbiter.summary})`);

    state.saveIterationLog(opts.projectRoot, opts.taskId, opts.step.service, iteration, {
      diff,
      review,
      arbiter,
    });

    opts.stepState.lastReviewComments = review.comments;
    opts.stepState.lastArbiterResult = arbiter;

    if (arbiter.decision === 'submit') {
      return {
        decision: 'submit',
        finalIteration: iteration,
        lastReviewComments: review.comments,
        lastArbiterResult: arbiter,
      };
    }

    if (arbiter.decision === 'escalate') {
      return {
        decision: 'escalate',
        finalIteration: iteration,
        lastReviewComments: review.comments,
        lastArbiterResult: arbiter,
      };
    }

    if (iteration >= opts.config.review.max_iterations) {
      return {
        decision: 'escalate',
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
        decision: 'escalate',
        finalIteration: iteration,
        lastReviewComments: review.comments,
        lastArbiterResult: {
          decision: 'escalate',
          reasoning: 'Arbiter returned fix decision without feedback_for_codex.',
          summary: 'Escalated because fix instructions were missing.',
        },
      };
    }

    logger.info('Applying arbiter feedback with codex');
    await codex.exec({
      spec: arbiter.feedback_for_codex,
      model: opts.config.codex.model,
      cwd: serviceRoot,
      verbose: opts.verbose,
    });

    iteration += 1;
    opts.stepState.iteration = iteration;
  }
}
