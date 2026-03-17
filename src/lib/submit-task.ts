import fs from 'node:fs';
import path from 'node:path';

import * as codex from './codex.js';
import * as gh from './gh.js';
import * as git from './git.js';
import * as logger from './logger.js';
import { saveState } from './state.js';
import { ensureTaskDirectory, moveTaskFileAtomically } from './tasks.js';
import type { VexdoConfig, VexdoState } from '../types/index.js';

export async function submitActiveTask(projectRoot: string, config: VexdoConfig, state: VexdoState): Promise<void> {
  for (const step of state.steps) {
    const isSubmittable = step.status === 'done' || step.status === 'in_progress' || step.status === 'escalated';
    if (!isSubmittable) {
      continue;
    }

    const service = config.services.find((item) => item.name === step.service);
    if (!service) {
      throw new Error(`Unknown service in state: ${step.service}`);
    }

    const servicePath = path.resolve(projectRoot, service.path);
    if (!step.branch) {
      throw new Error(`No branch found in state for service ${step.service}. Cannot create PR.`);
    }

    if (step.status === 'escalated' && step.session_id) {
      logger.warn(`[${step.service}] Escalated — applying pending Codex diff before creating PR...`);
      await git.checkoutBranch(step.branch, servicePath);
      await codex.applyDiff(step.session_id, {cwd: servicePath});
      await git.exec(['add', '-A'], servicePath);
      await git.exec(['commit', '-m', 'chore: apply escalated codex changes'], servicePath);
      await git.push(step.branch, servicePath);
    }

    const body = `Task: ${state.taskId}\nService: ${step.service}`;
    const url = await gh.createPr({
      title: `${state.taskTitle} [${step.service}]`,
      body,
      head: step.branch,
      base: config.codex.base_branch,
      cwd: servicePath,
    });

    logger.success(`PR created: ${url}`);
  }

  state.status = 'done';

  const doneDir = ensureTaskDirectory(projectRoot, 'done');
  if (fs.existsSync(state.taskPath)) {
    state.taskPath = moveTaskFileAtomically(state.taskPath, doneDir);
  }

  saveState(projectRoot, state);
}
