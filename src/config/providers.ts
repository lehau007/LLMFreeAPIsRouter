import { ModelConfig, ProviderConfig } from '../types';
import { EncryptionUtil } from '../utils/encryption';
import { config as envConfig } from './env';

export interface ProviderRegistryEntry {
  name: string;
  envVar: string;          // e.g. 'GOOGLE_API_KEY'
  rpmEnv?: string;
  rpdEnv?: string;
  models: ModelConfig[];
  // providerModelIds we explicitly never want — even if discovery surfaces them
  // as "added". The refresh agent reads this and skips PR-suggesting them.
  excluded?: string[];
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
      { id: 'claude-3-5-sonnet-20241022', providerModelId: 'gemini-2.5-flash',      priority: 2, capability: 'multimodal', tier: 'balanced' },
      { id: 'claude-3-haiku-20240307',    providerModelId: 'gemini-2.5-flash-lite', priority: 2, capability: 'multimodal', tier: 'fast' },
      // Native Google model IDs (direct passthrough)
      // --- balanced tier ---
      { id: 'gemini-3.5-flash',           providerModelId: 'gemini-3.5-flash',      priority: 1, capability: 'multimodal', tier: 'balanced' },
      { id: 'gemini-2.5-flash',           providerModelId: 'gemini-2.5-flash',      priority: 2, capability: 'multimodal', tier: 'balanced' },
      { id: 'gemini-2.0-flash',           providerModelId: 'gemini-2.0-flash',      priority: 3, capability: 'multimodal', tier: 'balanced' },
      // --- fast tier ---
      { id: 'gemini-2.5-flash-lite',      providerModelId: 'gemini-2.5-flash-lite', priority: 2, capability: 'multimodal', tier: 'fast' },
      { id: 'gemini-3.1-flash-lite',      providerModelId: 'gemini-3.1-flash-lite', priority: 3, capability: 'multimodal', tier: 'fast' },
      { id: 'gemini-2.0-flash-lite',      providerModelId: 'gemini-2.0-flash-lite', priority: 4, capability: 'multimodal', tier: 'fast' },
      // --- powerful tier ---
      { id: 'gemini-2.5-pro',             providerModelId: 'gemini-2.5-pro',        priority: 1, capability: 'multimodal', tier: 'powerful' },
    ],
    // Models we explicitly never want surfaced in PROVIDER_REGISTRY or
    // re-suggested by the refresh agent. Reasons:
    //  - gemma-4-*: free-tier instability observed in production traffic.
    //  - *-latest aliases: volatile (Google can repoint without notice).
    //  - *-001 dated pins: redundant with the unversioned id.
    //  - *-preview / preview-*: experimental, not stable enough for default routing.
    //  - tts / image / lyria / whisper / orpheus: not text-generation models.
    //  - robotics / computer-use / antigravity / deep-research: specialized agents.
    //  - prompt-guard / safeguard: moderation classifiers, not chat.
    //  - groq/compound*: agentic tool-use system with a different interface.
    //  - allam-2-7b: Arabic-specialized, narrow use case.
    excluded: [
      // Free-tier instability
      'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
      // Volatile aliases (Google can repoint without notice)
      'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest',
      // Dated pins (redundant with unversioned id)
      'gemini-2.0-flash-001', 'gemini-2.0-flash-lite-001',
      // TTS
      'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts',
      'gemini-3.1-flash-tts-preview',
      // Image generation (Nano Banana)
      'gemini-2.5-flash-image', 'gemini-3-pro-image-preview',
      'nano-banana-pro-preview', 'gemini-3.1-flash-image-preview',
      // Music generation
      'lyria-3-clip-preview', 'lyria-3-pro-preview',
      // Robotics / computer-use / agent specialized
      'gemini-robotics-er-1.5-preview', 'gemini-robotics-er-1.6-preview',
      'gemini-2.5-computer-use-preview-10-2025',
      'antigravity-preview-05-2026',
      'deep-research-max-preview-04-2026',
      'deep-research-preview-04-2026',
      'deep-research-pro-preview-12-2025',
      // Gemini 3 / 3.1 previews (waiting for GA)
      'gemini-3-pro-preview', 'gemini-3-flash-preview',
      'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools',
      'gemini-3.1-flash-lite-preview',
    ],
  },
  {
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    rpmEnv: 'GROQ_RPM',
    rpdEnv: 'GROQ_RPD',
    models: [
      // Anthropic-compatible alias → Groq text model
      { id: 'claude-3-sonnet-20240229',                  providerModelId: 'openai/gpt-oss-120b',                       priority: 1, capability: 'text',       tier: 'balanced' },
      // --- balanced tier ---
      { id: 'openai/gpt-oss-120b',                       providerModelId: 'openai/gpt-oss-120b',                       priority: 1, capability: 'text',       tier: 'balanced' },
      { id: 'llama-3.3-70b-versatile',                   providerModelId: 'llama-3.3-70b-versatile',                   priority: 1, capability: 'text',       tier: 'balanced' },
      { id: 'qwen/qwen3-32b',                            providerModelId: 'qwen/qwen3-32b',                            priority: 2, capability: 'text',       tier: 'balanced' },
      // --- fast tier ---
      // Llama 4 Scout is multimodal — only multimodal model Groq exposes on free tier.
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', providerModelId: 'meta-llama/llama-4-scout-17b-16e-instruct', priority: 2, capability: 'multimodal', tier: 'fast' },
      { id: 'llama-3.1-8b-instant',                      providerModelId: 'llama-3.1-8b-instant',                      priority: 1, capability: 'text',       tier: 'fast' },
      { id: 'openai/gpt-oss-20b',                        providerModelId: 'openai/gpt-oss-20b',                        priority: 2, capability: 'text',       tier: 'fast' },
    ],
    excluded: [
      // Speech / TTS / audio-only — not text generation
      'whisper-large-v3', 'whisper-large-v3-turbo',
      'canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi',
      // Moderation classifiers, not chat models
      'meta-llama/llama-prompt-guard-2-22m', 'meta-llama/llama-prompt-guard-2-86m',
      'openai/gpt-oss-safeguard-20b',
      // Agentic tool-use system — different interface than /v1/chat/completions
      'groq/compound', 'groq/compound-mini',
      // Narrow-language specialized
      'allam-2-7b',
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
