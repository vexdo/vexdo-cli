import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findProjectRoot, loadConfig } from '../src/lib/config.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexdo-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '.vexdo.yml'), content, 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findProjectRoot', () => {
  it('finds a parent directory containing .vexdo.yml', () => {
    const root = makeTempDir();
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    writeConfig(root, 'version: 1\nservices:\n  - name: api\n    path: ./api\n');

    expect(findProjectRoot(nested)).toBe(root);
  });

  it('returns null when no config exists', () => {
    const dir = makeTempDir();
    expect(findProjectRoot(dir)).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads valid config', () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `version: 1
services:
  - name: api
    path: ./services/api
review:
  model: custom-review
  max_iterations: 7
  auto_submit: true
codex:
  model: custom-codex
`,
    );

    const result = loadConfig(root);

    expect(result).toEqual({
      version: 1,
      services: [{ name: 'api', path: './services/api' }],
      review: { model: 'custom-review', max_iterations: 7, auto_submit: true },
      codex: { model: 'custom-codex' },
    });
  });

  it('applies defaults for review and codex', () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `version: 1
services:
  - name: api
    path: ./services/api
`,
    );

    const result = loadConfig(root);

    expect(result.review).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_iterations: 3,
      auto_submit: false,
    });
    expect(result.codex).toEqual({ model: 'gpt-4o' });
  });

  it('throws when config file is missing', () => {
    const root = makeTempDir();
    expect(() => loadConfig(root)).toThrowError(/Configuration file not found/);
  });

  it('throws for wrong version', () => {
    const root = makeTempDir();
    writeConfig(root, 'version: 2\nservices:\n  - name: api\n    path: ./api\n');

    expect(() => loadConfig(root)).toThrowError('version must be 1');
  });

  it('throws for empty services', () => {
    const root = makeTempDir();
    writeConfig(root, 'version: 1\nservices: []\n');

    expect(() => loadConfig(root)).toThrowError('services must be a non-empty array');
  });

  it('throws for missing service name', () => {
    const root = makeTempDir();
    writeConfig(root, 'version: 1\nservices:\n  - path: ./api\n');

    expect(() => loadConfig(root)).toThrowError('services[0].name must be a non-empty string');
  });

  it('throws for invalid yaml', () => {
    const root = makeTempDir();
    writeConfig(root, 'version: 1\nservices:\n  - name: api\n    path: [\n');

    expect(() => loadConfig(root)).toThrowError(/Invalid YAML/);
  });
});
