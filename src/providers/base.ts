import { ChatRequest, ChatResponse, ProviderConfig, StreamEvent } from '../types';
import { canMakeRequest, ProviderLimits } from '../utils/rateLimits';

export class NoAvailableKeyError extends Error {
  constructor(providerName: string, modelId: string) {
    super(`No available key for ${providerName}:${modelId} (all cooled down or saturated)`);
    this.name = 'NoAvailableKeyError';
  }
}

export abstract class BaseProvider {
  public config: ProviderConfig;
  public isHealthy: boolean = true;
  public consecutiveFailures: number = 0;
  private cooldowns: Map<string, number> = new Map();
  protected lastUsed: number = 0;
  protected latency: number = 0;
  private keyIdx: number = 0;
  public lastKeyIndex: number = 0;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // Scan from the round-robin cursor and return the first key that is neither cooled
  // down nor over its sliding rate-limit window. Returns null if none usable.
  public nextKey(modelId: string): { key: string; index: number } | null {
    const keys = this.config.apiKeys;
    const n = keys.length;
    if (n === 0) return null;
    const limits: ProviderLimits = { rpm: this.config.rpm ?? null, rpd: this.config.rpd ?? null };
    const hasLimits = limits.rpm !== null || limits.rpd !== null;
    const start = this.keyIdx;
    for (let i = 0; i < n; i++) {
      const index = (start + i) % n;
      if (this.isCooledDown(modelId, index)) continue;
      if (hasLimits && !canMakeRequest(this.getName(), modelId, index, limits)) continue;
      this.keyIdx = (index + 1) % n;
      this.lastKeyIndex = index;
      return { key: keys[index], index };
    }
    return null;
  }

  public keyCount(): number { return this.config.apiKeys.length; }

  public setCooldown(modelId: string, keyIndex: number, durationMs: number): void {
    this.cooldowns.set(`${modelId}:${keyIndex}`, Date.now() + durationMs);
  }

  public isCooledDown(modelId: string, keyIndex: number): boolean {
    const expiry = this.cooldowns.get(`${modelId}:${keyIndex}`);
    if (!expiry) return false;
    if (Date.now() > expiry) { this.cooldowns.delete(`${modelId}:${keyIndex}`); return false; }
    return true;
  }

  public hasAvailableKey(modelId: string): boolean {
    for (let i = 0; i < this.config.apiKeys.length; i++) {
      if (!this.isCooledDown(modelId, i)) return true;
    }
    return false;
  }

  /**
   * Translates common ChatRequest to Provider specific request and makes the API call.
   */
  abstract chat(request: ChatRequest, mappedModelId: string): Promise<ChatResponse>;

  /**
   * Similar to chat, but returns an AsyncIterable for streaming.
   */
  abstract streamChat(request: ChatRequest, mappedModelId: string): AsyncIterable<StreamEvent>;

  public getName(): string {
    return this.config.name;
  }

  public getModels(): string[] {
    return this.config.models.map(m => m.id);
  }

  public supportsModel(modelId: string): boolean {
    return this.config.models.some(m => m.id === modelId);
  }

  public getProviderModelId(modelId: string): string | undefined {
    const model = this.config.models.find(m => m.id === modelId);
    return model?.providerModelId;
  }

  public recordSuccess(latencyMs: number) {
    this.isHealthy = true;
    this.consecutiveFailures = 0;
    this.lastUsed = Date.now();
    // Simple moving average for latency
    this.latency = this.latency === 0 ? latencyMs : (this.latency * 0.7 + latencyMs * 0.3);
  }

  public recordFailure(modelId: string, keyIndex: number, isRateLimit: boolean = false, isServerError: boolean = false, resetTimeMs?: number) {
    if (isRateLimit) {
      this.setCooldown(modelId, keyIndex, resetTimeMs ?? 60000);
      console.warn(`Provider ${this.getName()} hit rate limit on ${modelId} key#${keyIndex}. Cooldown ${resetTimeMs ?? 60000}ms.`);
    } else if (isServerError) {
      this.setCooldown(modelId, keyIndex, resetTimeMs ?? 30000);
      this.consecutiveFailures += 1;
      console.warn(`Provider ${this.getName()} hit server error on ${modelId} key#${keyIndex}. Cooldown ${resetTimeMs ?? 30000}ms.`);
      if (this.consecutiveFailures >= 3) {
        this.isHealthy = false;
        console.error(`Provider ${this.getName()} marked UNHEALTHY after ${this.consecutiveFailures} failures.`);
      }
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 3) {
        this.isHealthy = false;
        console.error(`Provider ${this.getName()} marked UNHEALTHY after ${this.consecutiveFailures} failures.`);
      }
    }
  }

  public isAvailable(): boolean {
    return this.isHealthy;
  }

  public getScore(priority: number): number {
    if (!this.isAvailable()) return -1;

    const priorityScore = (100 - priority) * 1000;
    const latencyScore = Math.max(0, 5000 - this.latency);

    return priorityScore + latencyScore;
  }
}
