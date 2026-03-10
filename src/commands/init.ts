import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { Command } from 'commander';
import { stringify } from 'yaml';

import * as logger from '../lib/logger.js';
import type { VexdoConfig } from '../types/index.js';

const DEFAULT_REVIEW_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_CODEX_MODEL = 'gpt-4o';

const TASK_DIRS = ['backlog', 'in_progress', 'review', 'done', 'blocked'] as const;

export type PromptFn = (question: string) => Promise<string>;

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function parseServices(value: string): string[] {
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return Array.from(new Set(parsed));
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

function parseMaxIterations(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ITERATIONS;
}

function ensureGitignoreEntry(gitignorePath: string, entry: string): boolean {
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
    return true;
  }

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(entry)) {
    return false;
  }

  const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${suffix}${entry}\n`, 'utf8');
  return true;
}

export async function runInit(projectRoot: string, prompt: PromptFn = defaultPrompt): Promise<void> {
  const configPath = path.join(projectRoot, '.vexdo.yml');

  if (fs.existsSync(configPath)) {
    logger.warn('Found existing .vexdo.yml.');
    const overwriteAnswer = await prompt('Overwrite existing .vexdo.yml? (y/N): ');
    if (!parseBoolean(overwriteAnswer)) {
      logger.info('Initialization cancelled.');
      return;
    }
  }

  let services = parseServices(await prompt('Project services (comma-separated names, e.g. api,web): '));
  if (services.length === 0) {
    services = ['api'];
  }

  const serviceConfigs: VexdoConfig['services'] = [];
  for (const name of services) {
    const answer = await prompt(`Path for ${name} (default: ./${name}): `);
    serviceConfigs.push({
      name,
      path: answer.trim().length > 0 ? answer.trim() : `./${name}`,
    });
  }

  const reviewModelRaw = await prompt(`Review model (default: ${DEFAULT_REVIEW_MODEL}): `);
  const maxIterationsRaw = await prompt(`Max review iterations (default: ${String(DEFAULT_MAX_ITERATIONS)}): `);
  const autoSubmitRaw = await prompt('Auto-submit PRs? (y/N): ');
  const codexModelRaw = await prompt(`Codex model (default: ${DEFAULT_CODEX_MODEL}): `);

  const config: VexdoConfig = {
    version: 1,
    services: serviceConfigs,
    review: {
      model: reviewModelRaw.trim() || DEFAULT_REVIEW_MODEL,
      max_iterations: maxIterationsRaw.trim() ? parseMaxIterations(maxIterationsRaw.trim()) : DEFAULT_MAX_ITERATIONS,
      auto_submit: parseBoolean(autoSubmitRaw),
    },
    codex: {
      model: codexModelRaw.trim() || DEFAULT_CODEX_MODEL,
    },
  };

  fs.writeFileSync(configPath, stringify(config), 'utf8');

  const createdDirs: string[] = [];
  for (const taskDir of TASK_DIRS) {
    const directory = path.join(projectRoot, 'tasks', taskDir);
    fs.mkdirSync(directory, { recursive: true });
    createdDirs.push(path.relative(projectRoot, directory));
  }

  const logDir = path.join(projectRoot, '.vexdo', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  createdDirs.push(path.relative(projectRoot, logDir));

  const gitignorePath = path.join(projectRoot, '.gitignore');
  const gitignoreUpdated = ensureGitignoreEntry(gitignorePath, '.vexdo/');

  logger.success('Initialized vexdo project.');
  logger.info(`Created: ${path.relative(projectRoot, configPath)}`);
  logger.info(`Created directories: ${createdDirs.join(', ')}`);
  if (gitignoreUpdated) {
    logger.info('Updated .gitignore with .vexdo/');
  }
  logger.info("Next: create a task file in tasks/backlog/ and run 'vexdo start tasks/backlog/my-task.yml'");
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize vexdo in the current project')
    .action(async () => {
      await runInit(process.cwd());
    });
}
