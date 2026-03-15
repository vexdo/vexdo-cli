import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import type { CodexConfig, ReviewConfig, ServiceConfig, VexdoConfig } from '../types/index.js';

const DEFAULT_REVIEW_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_AUTO_SUBMIT = false;
const DEFAULT_CODEX_MODEL = 'gpt-4o';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readObjectField(obj: Record<string, unknown>, fieldPath: string): unknown {
  return obj[fieldPath];
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return value;
}

function parseServices(value: unknown): ServiceConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('services must be a non-empty array');
  }

  return value.map((service, index) => {
    if (!isRecord(service)) {
      throw new Error(`services[${String(index)}] must be an object`);
    }

    const name = requireString(readObjectField(service, 'name'), `services[${String(index)}].name`);
    const servicePath = requireString(readObjectField(service, 'path'), `services[${String(index)}].path`);

    return {
      name,
      path: servicePath,
    };
  });
}

function parseReview(value: unknown): ReviewConfig {
  if (value === undefined) {
    return {
      model: DEFAULT_REVIEW_MODEL,
      max_iterations: DEFAULT_MAX_ITERATIONS,
      auto_submit: DEFAULT_AUTO_SUBMIT,
    };
  }

  if (!isRecord(value)) {
    throw new Error('review must be an object');
  }

  const modelRaw = readObjectField(value, 'model');
  const iterationsRaw = readObjectField(value, 'max_iterations');
  const autoSubmitRaw = readObjectField(value, 'auto_submit');

  const model = modelRaw === undefined ? DEFAULT_REVIEW_MODEL : requireString(modelRaw, 'review.model');

  let max_iterations = DEFAULT_MAX_ITERATIONS;
  if (iterationsRaw !== undefined) {
    if (typeof iterationsRaw !== 'number' || !Number.isInteger(iterationsRaw) || iterationsRaw <= 0) {
      throw new Error('review.max_iterations must be a positive integer');
    }
    max_iterations = iterationsRaw;
  }

  let auto_submit = DEFAULT_AUTO_SUBMIT;
  if (autoSubmitRaw !== undefined) {
    if (typeof autoSubmitRaw !== 'boolean') {
      throw new Error('review.auto_submit must be a boolean');
    }
    auto_submit = autoSubmitRaw;
  }

  return {
    model,
    max_iterations,
    auto_submit,
  };
}


function parseMaxConcurrent(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('maxConcurrent must be a positive integer');
  }

  return value;
}

function parseCodex(value: unknown): CodexConfig {
  if (value === undefined) {
    return { model: DEFAULT_CODEX_MODEL };
  }

  if (!isRecord(value)) {
    throw new Error('codex must be an object');
  }

  const modelRaw = readObjectField(value, 'model');
  const model = modelRaw === undefined ? DEFAULT_CODEX_MODEL : requireString(modelRaw, 'codex.model');
  return { model };
}

export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  let reachedRoot = false;

  while (!reachedRoot) {
    const candidate = path.join(current, '.vexdo.yml');
    if (fs.existsSync(candidate)) {
      return current;
    }

    const parent = path.dirname(current);
    reachedRoot = parent === current;
    current = parent;
  }

  return null;
}

export function loadConfig(projectRoot: string): VexdoConfig {
  const configPath = path.join(projectRoot, '.vexdo.yml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const configRaw = fs.readFileSync(configPath, 'utf8');
  let parsed: unknown;

  try {
    parsed = parse(configRaw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML in .vexdo.yml: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('config must be an object');
  }

  const versionRaw = readObjectField(parsed, 'version');
  if (versionRaw !== 1) {
    throw new Error('version must be 1');
  }

  const services = parseServices(readObjectField(parsed, 'services'));
  const review = parseReview(readObjectField(parsed, 'review'));
  const codex = parseCodex(readObjectField(parsed, 'codex'));
  const maxConcurrent = parseMaxConcurrent(readObjectField(parsed, 'maxConcurrent'));

  return {
    version: 1,
    services,
    review,
    codex,
    maxConcurrent,
  };
}
