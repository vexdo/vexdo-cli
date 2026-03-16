import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDiffMock, codexExecMock, saveIterationLogMock, reviewSummaryMock, infoMock, iterationMock, runCopilotReviewMock } = vi.hoisted(() => ({
  getDiffMock: vi.fn(),
  codexExecMock: vi.fn(),
  saveIterationLogMock: vi.fn(),
  reviewSummaryMock: vi.fn(),
  infoMock: vi.fn(),
  iterationMock: vi.fn(),
  runCopilotReviewMock: vi.fn(),
}));

vi.mock('../../src/lib/git.js', () => ({
  getDiff: getDiffMock,
}));

vi.mock('../../src/lib/codex.js', () => ({
  exec: codexExecMock,
}));

vi.mock('../../src/lib/state.js', () => ({
  saveIterationLog: saveIterationLogMock,
}));

vi.mock('../../src/lib/copilot.js', () => ({
  runCopilotReview: runCopilotReviewMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  reviewSummary: reviewSummaryMock,
  info: infoMock,
  iteration: iterationMock,
}));

import { runReviewLoop } from '../../src/lib/review-loop.js';
import type { ArbiterResult, ReviewResult, StepState, Task, TaskStep, VexdoConfig } from '../../src/types/index.js';

describe('runReviewLoop', () => {
  const task: Task = { id: 't1', title: 'Task', steps: [] };
  const step: TaskStep = { service: 'svc', spec: 'spec text' };
  const config: VexdoConfig = {
    version: 1,
    services: [{ name: 'svc', path: '.' }],
    review: { model: 'claude-sonnet', max_iterations: 2, auto_submit: false },
    codex: { model: 'gpt-5' },
  };
  let stepState: StepState;

  beforeEach(() => {
    getDiffMock.mockReset();
    codexExecMock.mockReset();
    saveIterationLogMock.mockReset();
    reviewSummaryMock.mockReset();
    infoMock.mockReset();
    iterationMock.mockReset();
    runCopilotReviewMock.mockReset();

    stepState = { service: 'svc', status: 'in_progress', iteration: 0 };
  });

  it('Empty diff returns submit immediately without calling Claude', async () => {
    getDiffMock.mockResolvedValue('');

    const claude = {
      runArbiter: vi.fn(),
    };

    const result = await runReviewLoop({
      taskId: 'task-1',
      task,
      step,
      stepState,
      projectRoot: '/repo',
      config,
      claude: claude as never,
    });

    expect(result.decision).toBe('submit');
    expect(runCopilotReviewMock).not.toHaveBeenCalled();
    expect(claude.runArbiter).not.toHaveBeenCalled();
  });

  it('submit decision returns correct ReviewLoopResult', async () => {
    getDiffMock.mockResolvedValue('diff');
    const review: ReviewResult = { comments: [{ severity: 'minor', comment: 'small' }] };
    runCopilotReviewMock.mockResolvedValue(review.comments);
    const arbiter: ArbiterResult = { decision: 'submit', reasoning: 'ok', summary: 'ok' };
    const claude = {
      runArbiter: vi.fn().mockResolvedValue(arbiter),
    };

    const result = await runReviewLoop({
      taskId: 'task-1',
      task,
      step,
      stepState,
      projectRoot: '/repo',
      config,
      claude: claude as never,
    });

    expect(result).toEqual({
      decision: 'submit',
      finalIteration: 0,
      lastReviewComments: review.comments,
      lastArbiterResult: arbiter,
    });
    expect(saveIterationLogMock).toHaveBeenCalledTimes(1);
  });

  it('escalate decision returns correct ReviewLoopResult', async () => {
    getDiffMock.mockResolvedValue('diff');
    const review: ReviewResult = { comments: [{ severity: 'critical', comment: 'broken' }] };
    runCopilotReviewMock.mockResolvedValue(review.comments);
    const arbiter: ArbiterResult = { decision: 'escalate', reasoning: 'conflict', summary: 'escalate' };
    const claude = {
      runArbiter: vi.fn().mockResolvedValue(arbiter),
    };

    const result = await runReviewLoop({ taskId: 'task-1', task, step, stepState, projectRoot: '/repo', config, claude: claude as never });

    expect(result.decision).toBe('escalate');
    expect(result.lastArbiterResult).toEqual(arbiter);
  });

  it('fix decision calls codex then loops', async () => {
    getDiffMock.mockResolvedValueOnce('diff-1').mockResolvedValueOnce('diff-2');
    runCopilotReviewMock.mockResolvedValueOnce([{ severity: 'important', comment: 'fix me' }]).mockResolvedValueOnce([]);
    const claude = {
      runArbiter: vi
        .fn()
        .mockResolvedValueOnce({ decision: 'fix', reasoning: 'needs fix', summary: 'fix', feedback_for_codex: 'edit file' })
        .mockResolvedValueOnce({ decision: 'submit', reasoning: 'done', summary: 'submit' }),
    };

    const result = await runReviewLoop({ taskId: 'task-1', task, step, stepState, projectRoot: '/repo', config, claude: claude as never });

    expect(codexExecMock).toHaveBeenCalledTimes(1);
    expect(result.decision).toBe('submit');
    expect(result.finalIteration).toBe(1);
  });

  it('After max_iterations with fix: escalates', async () => {
    stepState.iteration = 2;
    getDiffMock.mockResolvedValue('diff');
    runCopilotReviewMock.mockResolvedValue([{ severity: 'important', comment: 'still bad' }]);
    const claude = {
      runArbiter: vi.fn().mockResolvedValue({ decision: 'fix', reasoning: 'still broken', summary: 'fix again', feedback_for_codex: 'more' }),
    };

    const result = await runReviewLoop({ taskId: 'task-1', task, step, stepState, projectRoot: '/repo', config, claude: claude as never });

    expect(result.decision).toBe('escalate');
    expect(codexExecMock).not.toHaveBeenCalled();
  });

  it('dryRun skips all external calls', async () => {
    const claude = {
      runArbiter: vi.fn(),
    };

    const result = await runReviewLoop({
      taskId: 'task-1',
      task,
      step,
      stepState,
      projectRoot: '/repo',
      config,
      claude: claude as never,
      dryRun: true,
    });

    expect(result.decision).toBe('submit');
    expect(getDiffMock).not.toHaveBeenCalled();
    expect(codexExecMock).not.toHaveBeenCalled();
    expect(runCopilotReviewMock).not.toHaveBeenCalled();
    expect(claude.runArbiter).not.toHaveBeenCalled();
  });

  it('Iteration logs are saved on each iteration', async () => {
    getDiffMock.mockResolvedValueOnce('d1').mockResolvedValueOnce('d2').mockResolvedValueOnce('d3');
    runCopilotReviewMock
      .mockResolvedValueOnce([{ severity: 'important', comment: '1' }])
      .mockResolvedValueOnce([{ severity: 'important', comment: '2' }])
      .mockResolvedValueOnce([]);
    const claude = {
      runArbiter: vi
        .fn()
        .mockResolvedValueOnce({ decision: 'fix', reasoning: '1', summary: '1', feedback_for_codex: 'a' })
        .mockResolvedValueOnce({ decision: 'fix', reasoning: '2', summary: '2', feedback_for_codex: 'b' })
        .mockResolvedValueOnce({ decision: 'submit', reasoning: '3', summary: '3' }),
    };

    await runReviewLoop({ taskId: 'task-1', task, step, stepState, projectRoot: '/repo', config: { ...config, review: { ...config.review, max_iterations: 5 } }, claude: claude as never });

    expect(saveIterationLogMock).toHaveBeenCalledTimes(3);
  });
});
