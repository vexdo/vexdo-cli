import fs from 'node:fs';
import path from 'node:path';

import * as gh from './gh.js';
import * as logger from './logger.js';
import { clearState, saveState } from './state.js';
import { ensureTaskDirectory, moveTaskFileAtomically } from './tasks.js';
import type { VexdoConfig, VexdoState } from '../types/index.js';

export async function submitActiveTask(projectRoot: string, config: VexdoConfig, state: VexdoState): Promise<void> {
  for (const step of state.steps) {
    if (step.status !== 'done' && step.status !== 'in_progress') {
      continue;
    }

    const service = config.services.find((item) => item.name === step.service);
    if (!service) {
      throw new Error(`Unknown service in state: ${step.service}`);
    }

    const servicePath = path.resolve(projectRoot, service.path);
    const body = `Task: ${state.taskId}\nService: ${step.service}`;
    const url = await gh.createPr({
      title: `${state.taskTitle} [${step.service}]`,
      body,
      base: 'main',
      cwd: servicePath,
    });

    logger.success(`PR created: ${url}`);
  }

  state.status = 'done';
  saveState(projectRoot, state);

  const doneDir = ensureTaskDirectory(projectRoot, 'done');
  if (fs.existsSync(state.taskPath)) {
    state.taskPath = moveTaskFileAtomically(state.taskPath, doneDir);
    saveState(projectRoot, state);
  }

  clearState(projectRoot);
}
