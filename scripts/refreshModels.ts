// Discovers the live model catalog from each provider's own listing API and
// reports a diff against the currently-configured models in src/config/providers.ts.
//
// Run: `npm run refresh-models`
//
// Output: a single JSON document to stdout. The scheduled agent parses this,
// web-searches vision support for any new model id, edits providers.ts, and
// opens a PR. The script intentionally does NOT mutate providers.ts itself —
// model-list discovery is deterministic; vision classification is not, so the
// agent owns the edit step where judgment is needed.
//
// Stdout contract: ONLY the JSON document. Any banner/log/warn must go to stderr,
// otherwise downstream `JSON.parse(stdout)` breaks. dotenv is loaded by the
// transitive `../src/config/providers` import with `quiet:true` set in env.ts.

import { PROVIDER_REGISTRY, resolveProviderKeys, ProviderRegistryEntry } from '../src/config/providers';

interface GoogleModel {
  name: string;                          // e.g. "models/gemini-2.5-flash"
  baseModelId?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GroqModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  active?: boolean;
  context_window?: number;
}

interface ProviderDiscovery {
  configured: string[];
  discovered: string[];
  added: string[];
  removed: string[];
  details: Record<string, unknown>;
  error?: string;
}

async function listGoogleModels(apiKey: string): Promise<GoogleModel[]> {
  const out: GoogleModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw new Error(`Google listModels ${res.status}: ${await res.text()}`);
    const data = await res.json() as { models?: GoogleModel[]; nextPageToken?: string };
    if (data.models) out.push(...data.models);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function listGroqModels(apiKey: string): Promise<GroqModel[]> {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Groq listModels ${res.status}: ${await res.text()}`);
  const data = await res.json() as { data?: GroqModel[] };
  return data.data ?? [];
}

function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function diff(configured: string[], discovered: string[]) {
  const cSet = new Set(configured);
  const dSet = new Set(discovered);
  return {
    added: discovered.filter(id => !cSet.has(id)),
    removed: configured.filter(id => !dSet.has(id)),
  };
}

async function discoverGoogle(configured: string[], apiKey: string): Promise<ProviderDiscovery> {
  const models = await listGoogleModels(apiKey);
  const chat = models.filter(m => m.supportedGenerationMethods?.includes('generateContent'));
  const discovered = chat.map(m => stripModelsPrefix(m.name));
  const { added, removed } = diff(configured, discovered);
  const details: Record<string, unknown> = {};
  for (const m of chat) {
    const id = stripModelsPrefix(m.name);
    if (added.includes(id)) {
      details[id] = {
        displayName: m.displayName,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        supportedGenerationMethods: m.supportedGenerationMethods,
      };
    }
  }
  return { configured, discovered, added, removed, details };
}

async function discoverGroq(configured: string[], apiKey: string): Promise<ProviderDiscovery> {
  const models = await listGroqModels(apiKey);
  const active = models.filter(m => m.active !== false);
  const discovered = active.map(m => m.id);
  const { added, removed } = diff(configured, discovered);
  const details: Record<string, unknown> = {};
  for (const m of active) {
    if (added.includes(m.id)) {
      details[m.id] = { owned_by: m.owned_by, context_window: m.context_window, created: m.created };
    }
  }
  return { configured, discovered, added, removed, details };
}

type DiscoverFn = (configured: string[], apiKey: string) => Promise<ProviderDiscovery>;
const DISCOVERY: Record<string, DiscoverFn | undefined> = {
  Google: discoverGoogle,
  Groq: discoverGroq,
};

async function discoverOne(entry: ProviderRegistryEntry): Promise<ProviderDiscovery> {
  const configured = Array.from(new Set(entry.models.map(m => m.providerModelId)));
  const keys = resolveProviderKeys(entry.envVar);
  if (!keys) {
    return { configured, discovered: [], added: [], removed: [], details: {}, error: `${entry.envVar} not set` };
  }
  const fn = DISCOVERY[entry.name];
  if (!fn) {
    return { configured, discovered: [], added: [], removed: [], details: {}, error: `No discovery handler for provider ${entry.name}` };
  }
  try {
    const result = await fn(configured, keys[0]);
    // Drop excluded ids from `added` so the refresh agent doesn't re-suggest them.
    // They still appear in `discovered` so we can see they exist upstream.
    const excluded = new Set(entry.excluded ?? []);
    if (excluded.size > 0) {
      result.added = result.added.filter(id => !excluded.has(id));
      for (const id of [...Object.keys(result.details)]) {
        if (excluded.has(id)) delete result.details[id];
      }
    }
    return result;
  } catch (e: any) {
    return { configured, discovered: [], added: [], removed: [], details: {}, error: e.message };
  }
}

async function main() {
  const result: Record<string, ProviderDiscovery> = {};
  for (const entry of PROVIDER_REGISTRY) {
    result[entry.name] = await discoverOne(entry);
  }

  const hasChanges = Object.values(result).some(d => !d.error && (d.added.length > 0 || d.removed.length > 0));
  const summary = {
    timestamp: new Date().toISOString(),
    hasChanges,
    providers: result,
  };
  // Pure JSON to stdout. Nothing else.
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), error: err.message }) + '\n');
  process.exit(1);
});
