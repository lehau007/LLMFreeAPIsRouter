import { ModelConfig, ProviderConfig } from '../types';
import { EncryptionUtil } from '../utils/encryption';
import { config as envConfig } from './env';

export interface ProviderRegistryEntry {
  name: string;
  envVar: string;          // e.g. 'GOOGLE_API_KEY'
  rpmEnv?: string;
  rpdEnv?: string;
  models: ModelConfig[];
}

// Static declaration of every provider we route to, independent of which env
// vars are set. getProvidersConfig() filters this by credential presence, but
// the catalog-refresh script reads it directly so it can report a missing key
// as an error rather than silently dropping a whole provider.
export const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  {
    name: 'Google',
    envVar: 'GOOGLE_API_KEY',
    rpmEnv: 'GOOGLE_RPM',
    rpdEnv: 'GOOGLE_RPD',
    models: [
      // Anthropic-compatible aliases → Google equivalents
      { id: 'claude-3-5-sonnet-20241022', providerModelId: 'gemini-2.5-flash',      priority: 1, capability: 'multimodal', tier: 'balanced' },
      { id: 'claude-3-haiku-20240307',    providerModelId: 'gemini-2.5-flash-lite', priority: 2, capability: 'multimodal', tier: 'fast' },
      // Native Google model IDs (direct passthrough)
      { id: 'gemini-2.5-flash',           providerModelId: 'gemini-2.5-flash',      priority: 1, capability: 'multimodal', tier: 'balanced' },
      { id: 'gemini-2.5-flash-lite',      providerModelId: 'gemini-2.5-flash-lite', priority: 2, capability: 'multimodal', tier: 'fast' },
      { id: 'gemini-3.1-flash-lite',      providerModelId: 'gemini-3.1-flash-lite', priority: 3, capability: 'multimodal', tier: 'fast' },
      // Gemma 4 31B supports image understanding per ai.google.dev docs.
      { id: 'gemma-4-31b-it',             providerModelId: 'gemma-4-31b-it',        priority: 2, capability: 'multimodal', tier: 'balanced' },
    ],
  },
  {
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    rpmEnv: 'GROQ_RPM',
    rpdEnv: 'GROQ_RPD',
    models: [
      // Anthropic-compatible alias → Groq text model
      { id: 'claude-3-sonnet-20240229', providerModelId: 'openai/gpt-oss-120b',                       priority: 1, capability: 'text',       tier: 'balanced' },
      // Native Groq model IDs (direct passthrough)
      { id: 'openai/gpt-oss-120b',                       providerModelId: 'openai/gpt-oss-120b',                       priority: 1, capability: 'text',       tier: 'balanced' },
      // Groq's official id includes the full HF-style prefix and the size suffix.
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', providerModelId: 'meta-llama/llama-4-scout-17b-16e-instruct', priority: 2, capability: 'multimodal', tier: 'fast' },
    ],
  },
];

const parseLimit = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Parses a possibly comma-separated, possibly vault-encrypted env var into a
// list of plain-text keys. Returns null when the env var is missing/empty so
// callers can distinguish "no provider configured" from "provider misconfigured".
export function resolveProviderKeys(envVarName: string): string[] | null {
  const raw = process.env[envVarName];
  if (!raw) return null;
  const elements = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (elements.length === 0) return null;

  const masterKey = envConfig.masterKey!;
  return elements.map(key => {
    if (key.includes(':') && key.split(':').length === 4) {
      try {
        return EncryptionUtil.decrypt(key, masterKey);
      } catch {
        console.warn(`Warning: Failed to decrypt API key from ${envVarName}. Using as plain text.`);
        return key;
      }
    }
    return key;
  });
}

export function getProvidersConfig(): ProviderConfig[] {
  const configs: ProviderConfig[] = [];
  for (const entry of PROVIDER_REGISTRY) {
    const keys = resolveProviderKeys(entry.envVar);
    if (!keys) continue;
    configs.push({
      name: entry.name,
      apiKeys: keys,
      rpm: entry.rpmEnv ? parseLimit(process.env[entry.rpmEnv]) : null,
      rpd: entry.rpdEnv ? parseLimit(process.env[entry.rpdEnv]) : null,
      models: entry.models,
    });
  }
  if (configs.length === 0) {
    throw new Error('No provider API keys configured. Set at least one of GOOGLE_API_KEY or GROQ_API_KEY.');
  }
  return configs;
}
