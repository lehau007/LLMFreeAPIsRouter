import dns from 'dns/promises';
import net from 'net';

const FETCH_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Thrown for any client-input-side image-URL rejection (SSRF, bad protocol,
// non-image content-type, oversized payload). The router recognizes this
// class and surfaces it as 400 to the client without penalizing provider
// health or attempting failover — failover wouldn't help, the URL is the bug.
export class InvalidImageURLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageURLError';
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const family = net.isIP(hostname);
  if (family === 4) {
    if (isPrivateIPv4(hostname)) throw new InvalidImageURLError('Refusing to fetch private IPv4 address');
    return;
  }
  if (family === 6) {
    if (isPrivateIPv6(hostname)) throw new InvalidImageURLError('Refusing to fetch private IPv6 address');
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new InvalidImageURLError('DNS lookup returned no records');
  for (const r of records) {
    if (r.family === 4 && isPrivateIPv4(r.address)) throw new InvalidImageURLError(`Refusing to fetch ${hostname} (resolves to private ${r.address})`);
    if (r.family === 6 && isPrivateIPv6(r.address)) throw new InvalidImageURLError(`Refusing to fetch ${hostname} (resolves to private ${r.address})`);
  }
}

export async function safeFetchImage(url: string): Promise<{ mimeType: string; data: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new InvalidImageURLError('Invalid image URL'); }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new InvalidImageURLError(`Image URL protocol not allowed: ${parsed.protocol}`);

  await assertPublicHost(parsed.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new InvalidImageURLError(`Image fetch failed: ${res.status}`);

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) throw new InvalidImageURLError(`Image URL returned non-image content-type: ${contentType}`);

    const declaredLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new InvalidImageURLError(`Image exceeds ${MAX_IMAGE_BYTES} bytes (declared ${declaredLength})`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new InvalidImageURLError('Image response has no body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        reader.cancel().catch(() => {});
        throw new InvalidImageURLError(`Image exceeds ${MAX_IMAGE_BYTES} bytes (streamed)`);
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)), total);
    return { mimeType: contentType, data: buffer.toString('base64') };
  } finally {
    clearTimeout(timeout);
  }
}
