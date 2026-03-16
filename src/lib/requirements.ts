import * as codex from './codex.js';
import * as gh from './gh.js';

export function requireAnthropicApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  return apiKey;
}

export async function requireCodexAvailable(): Promise<void> {
  await codex.checkCodexAvailable();
}

export async function requireGhAvailable(): Promise<void> {
  await gh.checkGhAvailable();
}

export function resolveCodexEnvId(serviceName: string, configEnvId?: string): string {
  const envVarName = `CODEX_ENV_ID_${serviceName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const envId = configEnvId ?? process.env[envVarName];
  if (!envId) {
    throw new Error(
      `Codex environment ID is required for service "${serviceName}". ` +
      `Set env_id under services.${serviceName} in .vexdo.yml or export ${envVarName}=<id>.`,
    );
  }
  return envId;
}
