import { ChatRequest, ChatResponse, ProviderConfig, StreamEvent } from '../types';

export abstract class BaseProvider {
  public config: ProviderConfig;
  public isHealthy: boolean = true;
  public consecutiveFailures: number = 0;
  public rateLimitResetTime: number = 0;
  protected lastUsed: number = 0;
  protected latency: number = 0;

  constructor(config: ProviderConfig) {
    this.config = config;
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

  public recordFailure(isRateLimit: boolean = false, isServerError: boolean = false, resetTimeMs?: number) {
    if (isRateLimit) {
      this.rateLimitResetTime = Date.now() + (resetTimeMs || 60000);
      console.warn(`Provider ${this.getName()} hit rate limit. Cooldown until ${new Date(this.rateLimitResetTime).toISOString()}`);
    } else if (isServerError) {
      this.rateLimitResetTime = Date.now() + (resetTimeMs || 30000);
      this.consecutiveFailures += 1;
      console.warn(`Provider ${this.getName()} hit server error. Cooldown until ${new Date(this.rateLimitResetTime).toISOString()}`);
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 3) {
        this.isHealthy = false;
        console.error(`Provider ${this.getName()} marked UNHEALTHY after ${this.consecutiveFailures} failures.`);
      }
    }
  }

  public isAvailable(): boolean {
    if (!this.isHealthy) return false;
    if (this.rateLimitResetTime > Date.now()) return false;
    return true;
  }

  public getScore(priority: number): number {
    if (!this.isAvailable()) return -1;
    
    const priorityScore = (100 - priority) * 1000; 
    const latencyScore = Math.max(0, 5000 - this.latency);
    
    return priorityScore + latencyScore;
  }
}
