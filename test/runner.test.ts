import { describe, expect, it, vi } from 'vitest';

import { runStepsConcurrently } from '../src/lib/runner.js';
import type { TaskStep } from '../src/types/index.js';

describe('runStepsConcurrently', () => {
  it('runs independent steps in parallel', async () => {
    const steps: TaskStep[] = [
      { service: 'api', spec: 'a' },
      { service: 'web', spec: 'b' },
    ];

    let active = 0;
    let maxActive = 0;

    await runStepsConcurrently(steps, {}, async (step) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, step.service === 'api' ? 40 : 20));
      active -= 1;
      return { service: step.service, status: 'done' };
    });

    expect(maxActive).toBe(2);
  });

  it('waits for dependencies before dispatching', async () => {
    const steps: TaskStep[] = [
      { service: 'api', spec: 'a' },
      { service: 'worker', spec: 'w', depends_on: ['api'] },
    ];

    const order: string[] = [];

    await runStepsConcurrently(steps, {}, (step) => {
      order.push(step.service);
      return Promise.resolve({ service: step.service, status: 'done' as const });
    });

    expect(order).toEqual(['api', 'worker']);
  });

  it('marks dependent steps failed when dependency is escalated', async () => {
    const steps: TaskStep[] = [
      { service: 'api', spec: 'a' },
      { service: 'worker', spec: 'w', depends_on: ['api'] },
    ];

    const runStep = vi.fn((step: TaskStep) => {
      if (step.service === 'api') {
        return Promise.resolve({ service: step.service, status: 'escalated' as const });
      }
      return Promise.resolve({ service: step.service, status: 'done' as const });
    });

    const results = await runStepsConcurrently(steps, {}, runStep);

    expect(results).toEqual([
      { service: 'api', status: 'escalated' },
      { service: 'worker', status: 'failed', error: 'dependency_failed' },
    ]);
    expect(runStep).toHaveBeenCalledTimes(1);
  });

  it('respects maxConcurrent setting', async () => {
    const steps: TaskStep[] = [
      { service: 'api', spec: 'a' },
      { service: 'web', spec: 'b' },
      { service: 'worker', spec: 'c' },
    ];

    let active = 0;
    let maxActive = 0;

    await runStepsConcurrently(steps, { maxConcurrent: 2 }, async (step) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { service: step.service, status: 'done' };
    });

    expect(maxActive).toBe(2);
  });
});
