import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { runInit } from '../../src/commands/init.js';
import * as logger from '../../src/lib/logger.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-init-'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runInit', () => {
  it('creates .vexdo.yml with answers and all expected directories', async () => {
    const root = makeTempDir();

    const answers = [
      'api,web',
      '',
      './apps/web',
      'claude-sonnet-4-5',
      '5',
      'y',
      'gpt-4.1',
    ];

    await runInit(root, () => Promise.resolve(answers.shift() ?? ''));

    const configPath = path.join(root, '.vexdo.yml');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = parse(fs.readFileSync(configPath, 'utf8')) as {
      services: { name: string; path: string }[];
      review: { model: string; max_iterations: number; auto_submit: boolean };
      codex: { model: string; base_branch: string };
    };

    expect(config.services).toEqual([
      { name: 'api', path: './api' },
      { name: 'web', path: './apps/web' },
    ]);
    expect(config.review).toEqual({
      model: 'claude-sonnet-4-5',
      max_iterations: 5,
      auto_submit: true,
    });
    expect(config.codex).toEqual({ model: 'gpt-4.1', base_branch: 'main' });

    for (const taskDir of ['backlog', 'in_progress', 'review', 'done', 'blocked']) {
      expect(fs.existsSync(path.join(root, 'tasks', taskDir))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, '.vexdo', 'logs'))).toBe(true);
  });

  it('appends .vexdo/ to .gitignore once and does not duplicate on second run', async () => {
    const root = makeTempDir();

    const answersFirst = ['api', '', '', '', 'n', ''];
    await runInit(root, () => Promise.resolve(answersFirst.shift() ?? ''));

    let gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect((gitignore.match(/\.vexdo\//g) ?? []).length).toBe(1);

    const answersSecond = ['y', 'api', '', '', '', 'n', ''];
    await runInit(root, () => Promise.resolve(answersSecond.shift() ?? ''));

    gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect((gitignore.match(/\.vexdo\//g) ?? []).length).toBe(1);
  });

  it('warns and asks before overwrite when .vexdo.yml already exists', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, '.vexdo.yml'), 'version: 1\nservices: []\n', 'utf8');

    const warnSpy = vi.spyOn(logger, 'warn');
    const promptSpy = vi.fn(() => Promise.resolve('n'));

    await runInit(root, promptSpy);

    expect(warnSpy).toHaveBeenCalledWith('Found existing .vexdo.yml.');
    expect(promptSpy).toHaveBeenCalledWith('Overwrite existing .vexdo.yml? (y/N): ');
    const content = fs.readFileSync(path.join(root, '.vexdo.yml'), 'utf8');
    expect(content).toContain('services: []');
  });
});
