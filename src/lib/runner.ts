import type { TaskStep } from '../types/index.js';

export interface StepResult {
  service: string;
  status: 'done' | 'escalated' | 'failed';
  sessionId?: string;
  error?: string;
}

export interface RunConfig {
  maxConcurrent?: number;
}

export async function runStepsConcurrently(
  steps: TaskStep[],
  config: RunConfig,
  runStep: (step: TaskStep) => Promise<StepResult>,
): Promise<StepResult[]> {
  const maxConcurrent = config.maxConcurrent ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxConcurrent) && maxConcurrent !== Number.POSITIVE_INFINITY) {
    throw new Error('maxConcurrent must be a finite number when specified');
  }
  if (Number.isFinite(maxConcurrent) && (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0)) {
    throw new Error('maxConcurrent must be a positive integer when specified');
  }

  const stepByService = new Map(steps.map((step) => [step.service, step]));
  for (const step of steps) {
    for (const dependency of step.depends_on ?? []) {
      if (!stepByService.has(dependency)) {
        throw new Error(`Unknown dependency '${dependency}' for service '${step.service}'`);
      }
    }
  }

  const results = new Map<string, StepResult>();
  const running = new Map<string, Promise<void>>();

  while (results.size < steps.length) {
    let dispatched = false;

    for (const step of steps) {
      if (results.has(step.service) || running.has(step.service)) {
        continue;
      }

      const dependencies = step.depends_on ?? [];
      const depResults = dependencies.map((service) => results.get(service));
      if (depResults.some((result) => result === undefined)) {
        continue;
      }

      const blockedByDependencyFailure = depResults.some((result) => result?.status !== 'done');
      if (blockedByDependencyFailure) {
        results.set(step.service, {
          service: step.service,
          status: 'failed',
          error: 'dependency_failed',
        });
        dispatched = true;
        continue;
      }

      if (running.size >= maxConcurrent) {
        continue;
      }

      dispatched = true;
      const runningPromise = runStep(step)
        .then((result) => {
          results.set(step.service, result);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          results.set(step.service, {
            service: step.service,
            status: 'failed',
            error: message,
          });
        })
        .finally(() => {
          running.delete(step.service);
        });

      running.set(step.service, runningPromise);
    }

    if (!dispatched) {
      if (running.size === 0) {
        throw new Error('Unable to schedule all steps; dependency graph may contain a cycle.');
      }
      await Promise.race(running.values());
    }
  }

  return steps.map((step) => {
    const result = results.get(step.service);
    if (!result) {
      return {
        service: step.service,
        status: 'failed',
        error: 'not_executed',
      };
    }
    return result;
  });
}
