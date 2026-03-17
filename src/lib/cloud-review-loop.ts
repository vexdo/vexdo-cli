import type { ClaudeClient } from './claude.js';
import type { loadConfig } from './config.js';
import type { Logger } from './logger.js';
import * as codex from './codex.js';
import { generateCommitMessage, runCopilotReview, type ReviewIteration } from './copilot.js';
import * as git from './git.js';
import { saveIterationLog } from './state.js';
import type { ArbiterResult } from '../types/index.js';

export const POLL_INTERVAL_MS = 2 * 60_000;
export const POLL_TIMEOUT_MS = 60 * 60_000;

export async function runCloudReviewLoop(opts: {
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
  log: Logger;
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
      .map((line) => line.replace(/^diff --git a\/\S+ b\//, ''))
      .filter((f) => f.length > 0);
    opts.log.info(`Changed files (${String(changedFiles.length)}): ${changedFiles.join(', ')}`);
    opts.log.debug(diff);

    opts.log.info(`Running review (iteration ${String(iteration + 1)})...`);

    const reviewText = await runCopilotReview(opts.spec, diff, {
      cwd: opts.serviceRoot,
      history: history.length > 0 ? history : undefined,
      onChunk: (chunk) => { opts.log.debug(chunk.trimEnd()); },
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

    opts.log.info(`Applying diff and pushing to ${opts.branch}...`);
    await codex.applyDiff(sessionId, {cwd: opts.serviceRoot});
    const commitMessage = await generateCommitMessage(opts.spec, diff, {cwd: opts.serviceRoot});
    opts.log.info(`Commit: ${commitMessage}`);
    await git.commitFiles(changedFiles, commitMessage, opts.serviceRoot);
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
