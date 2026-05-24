const LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour, refreshed on each use

interface LockEntry {
  providerName: string;
  providerModelId: string;
  expiresAt: number;
}

const locks = new Map<string, LockEntry>();

export function setLock(clientToken: string, providerName: string, providerModelId: string): void {
  locks.set(clientToken, {
    providerName,
    providerModelId,
    expiresAt: Date.now() + LOCK_TTL_MS,
  });
}

export function getLock(clientToken: string): { providerName: string; providerModelId: string } | null {
  const entry = locks.get(clientToken);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    locks.delete(clientToken);
    return null;
  }
  entry.expiresAt = Date.now() + LOCK_TTL_MS; // refresh TTL on access
  return { providerName: entry.providerName, providerModelId: entry.providerModelId };
}

export function clearLock(clientToken: string): void {
  locks.delete(clientToken);
}
