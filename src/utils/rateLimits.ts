const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface Window { timestamps: number[]; }
const windows = new Map<string, Window>();

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) { w = { timestamps: [] }; windows.set(key, w); }
  return w;
}

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

export interface ProviderLimits {
  rpm: number | null;
  rpd: number | null;
}

export function canMakeRequest(
  providerName: string,
  modelId: string,
  keyIndex: number,
  limits: ProviderLimits,
): boolean {
  const now = Date.now();
  if (limits.rpm !== null) {
    const k = `${providerName}:${modelId}:${keyIndex}:rpm`;
    const w = getWindow(k);
    w.timestamps = prune(w.timestamps, MINUTE, now);
    if (w.timestamps.length >= limits.rpm) return false;
  }
  if (limits.rpd !== null) {
    const k = `${providerName}:${modelId}:${keyIndex}:rpd`;
    const w = getWindow(k);
    w.timestamps = prune(w.timestamps, DAY, now);
    if (w.timestamps.length >= limits.rpd) return false;
  }
  return true;
}

export function recordRequest(providerName: string, modelId: string, keyIndex: number): void {
  const now = Date.now();
  getWindow(`${providerName}:${modelId}:${keyIndex}:rpm`).timestamps.push(now);
  getWindow(`${providerName}:${modelId}:${keyIndex}:rpd`).timestamps.push(now);
}

export function hasAvailableKeyForLimits(
  providerName: string,
  modelId: string,
  keyCount: number,
  limits: ProviderLimits,
): boolean {
  for (let i = 0; i < keyCount; i++) {
    if (canMakeRequest(providerName, modelId, i, limits)) return true;
  }
  return false;
}
