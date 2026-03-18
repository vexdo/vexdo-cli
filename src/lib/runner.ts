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

interface ServiceGroup {
  service: string;
  steps: TaskStep[];
  dependsOn: Set<string>;
}

function groupStepsByService(steps: TaskStep[]): ServiceGroup[] {
  const groupMap = new Map<string, ServiceGroup>();
  const order: string[] = [];

  for (const step of steps) {
    if (!groupMap.has(step.service)) {
      groupMap.set(step.service, { service: step.service, steps: [], dependsOn: new Set() });
      order.push(step.service);
    }
    const group = groupMap.get(step.service);
    if (!group) {
      throw new Error(`Unexpected missing group for service ${step.service}`);
    }
    group.steps.push(step);
    for (const dep of step.depends_on ?? []) {
      if (dep !== step.service) {
        group.dependsOn.add(dep);
      }
    }
  }

  return order.map((s) => {
    const group = groupMap.get(s);
    if (!group) {
      throw new Error(`Unexpected missing group for service ${s}`);
    }
    return group;
  });
}

export async function runStepsConcurrently(
  steps: TaskStep[],
  config: RunConfig,
  runStep: (step: TaskStep, stepIndexWithinService: number) => Promise<StepResult>,
): Promise<StepResult[]> {
  const maxConcurrent = config.maxConcurrent ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxConcurrent) && maxConcurrent !== Number.POSITIVE_INFINITY) {
    throw new Error('maxConcurrent must be a finite number when specified');
  }
  if (Number.isFinite(maxConcurrent) && (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0)) {
    throw new Error('maxConcurrent must be a positive integer when specified');
  }

  const groups = groupStepsByService(steps);
  const serviceNames = new Set(groups.map((g) => g.service));

  for (const group of groups) {
    for (const dep of group.dependsOn) {
      if (!serviceNames.has(dep)) {
        throw new Error(`Unknown dependency '${dep}' for service '${group.service}'`);
      }
    }
  }

  const results = new Map<string, StepResult>();
  const running = new Map<string, Promise<void>>();

  while (results.size < groups.length) {
    let dispatched = false;

    for (const group of groups) {
      if (results.has(group.service) || running.has(group.service)) {
        continue;
      }

      const depResults = [...group.dependsOn].map((dep) => results.get(dep));
      if (depResults.some((result) => result === undefined)) {
        continue;
      }

      const blockedByDependencyFailure = depResults.some((result) => result?.status !== 'done');
      if (blockedByDependencyFailure) {
        results.set(group.service, { service: group.service, status: 'failed', error: 'dependency_failed' });
        dispatched = true;
        continue;
      }

      if (running.size >= maxConcurrent) {
        continue;
      }

      dispatched = true;

      const runningPromise = (async () => {
        let lastResult: StepResult = { service: group.service, status: 'failed', error: 'no_steps' };
        for (const [i, step] of group.steps.entries()) {
          const result = await runStep(step, i);
          lastResult = result;
          if (result.status !== 'done') {
            break;
          }
        }
        results.set(group.service, lastResult);
      })()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          results.set(group.service, { service: group.service, status: 'failed', error: message });
        })
        .finally(() => {
          running.delete(group.service);
        });

      running.set(group.service, runningPromise);
    }

    if (!dispatched) {
      if (running.size === 0) {
        throw new Error('Unable to schedule all steps; dependency graph may contain a cycle.');
      }
      await Promise.race(running.values());
    }
  }

  return groups.map((group) => {
    const result = results.get(group.service);
    if (!result) {
      throw new Error(`Unexpected missing result for service ${group.service}`);
    }
    return result;
  });
}
