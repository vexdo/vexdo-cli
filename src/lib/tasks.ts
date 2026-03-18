import fs from 'node:fs';
import path from 'node:path';

import { load as parseYaml } from 'js-yaml';

import type { StepState, Task, TaskStep, VexdoConfig } from '../types/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value;
}

function parseTaskStep(value: unknown, index: number, config: VexdoConfig): TaskStep {
  if (!isRecord(value)) {
    throw new Error(`steps[${String(index)}] must be an object`);
  }

  const service = requireString(value.service, `steps[${String(index)}].service`);
  const spec = requireString(value.spec, `steps[${String(index)}].spec`);

  if (!config.services.some((item) => item.name === service)) {
    throw new Error(`steps[${String(index)}].service references unknown service '${service}'`);
  }

  const dependsOnRaw = value.depends_on;
  let depends_on: string[] | undefined;

  if (dependsOnRaw !== undefined) {
    if (!Array.isArray(dependsOnRaw) || !dependsOnRaw.every((dep) => typeof dep === 'string' && dep.trim().length > 0)) {
      throw new Error(`steps[${String(index)}].depends_on must be an array of non-empty strings`);
    }
    depends_on = dependsOnRaw;
  }

  return {
    service,
    spec,
    depends_on,
  };
}


function validateDependencies(steps: TaskStep[]): void {
  const serviceNames = new Set(steps.map((step) => step.service));

  // Collect depends_on per service (union across all steps for that service)
  const serviceDeps = new Map<string, Set<string>>();
  for (const service of serviceNames) {
    serviceDeps.set(service, new Set());
  }

  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (!serviceNames.has(dep)) {
        throw new Error(`step for '${step.service}' depends on unknown service '${dep}'`);
      }
      if (dep === step.service) {
        throw new Error(`step for '${step.service}' cannot depend on itself`);
      }
      const deps = serviceDeps.get(step.service);
      if (!deps) {
        throw new Error(`Unexpected missing deps set for service ${step.service}`);
      }
      deps.add(dep);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (service: string): void => {
    if (visited.has(service)) {
      return;
    }
    if (visiting.has(service)) {
      throw new Error(`Dependency cycle detected involving service '${service}'`);
    }

    visiting.add(service);
    for (const dep of serviceDeps.get(service) ?? []) {
      visit(dep);
    }
    visiting.delete(service);
    visited.add(service);
  };

  for (const service of serviceNames) {
    visit(service);
  }
}

export function loadAndValidateTask(taskPath: string, config: VexdoConfig): Task {
  const raw = fs.readFileSync(taskPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid task YAML: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('task must be a YAML object');
  }

  const id = requireString(parsed.id, 'id');
  const title = requireString(parsed.title, 'title');

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }

  const steps = parsed.steps.map((step, index) => parseTaskStep(step, index, config));
  validateDependencies(steps);

  return { id, title, steps };
}

export function buildInitialStepState(task: Task): StepState[] {
  const seen = new Set<string>();
  return task.steps
    .filter((step) => {
      if (seen.has(step.service)) return false;
      seen.add(step.service);
      return true;
    })
    .map((step) => ({
      service: step.service,
      status: 'pending' as const,
      iteration: 0,
      currentStepIndex: 0,
    }));
}

export function ensureTaskDirectory(projectRoot: string, taskState: 'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'): string {
  const dir = path.join(projectRoot, 'tasks', taskState);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function moveTaskFileAtomically(taskPath: string, destinationDir: string): string {
  const destinationPath = path.join(destinationDir, path.basename(taskPath));
  fs.renameSync(taskPath, destinationPath);
  return destinationPath;
}
