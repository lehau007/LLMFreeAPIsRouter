import { BaseProvider } from '../providers/base';
import { ChatRequest, ChatResponse, StreamEvent } from '../types';
import { logRequest } from '../utils/logger';
import { recordRequest, hasAvailableKeyForLimits, ProviderLimits } from '../utils/rateLimits';

export interface RouteContext { attempts: number; }

const PENALTY_PER_429 = 3;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 2 * 60 * 1000;
const DECAY_AMOUNT = 1;

const rateLimitPenalties = new Map<string, { count: number; lastHit: number; penalty: number }>();

function penaltyKey(providerName: string, modelId: string): string {
  return `${providerName}:${modelId}`;
}

export function recordRateLimitHit(providerName: string, modelId: string): void {
  const k = penaltyKey(providerName, modelId);
  const existing = rateLimitPenalties.get(k);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(k, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

export function recordPenaltyDecay(providerName: string, modelId: string): void {
  const k = penaltyKey(providerName, modelId);
  const existing = rateLimitPenalties.get(k);
  if (!existing) return;
  existing.penalty = Math.max(0, existing.penalty - 1);
  if (existing.penalty === 0) rateLimitPenalties.delete(k);
}

function getPenalty(providerName: string, modelId: string): number {
  const k = penaltyKey(providerName, modelId);
  const entry = rateLimitPenalties.get(k);
  if (!entry) return 0;
  const now = Date.now();
  const decaySteps = Math.floor((now - entry.lastHit) / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - decaySteps * DECAY_AMOUNT);
    entry.lastHit = now;
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(k);
      return 0;
    }
  }
  return entry.penalty;
}

export class Router {
  private providers: BaseProvider[] = [];

  constructor(providers: BaseProvider[]) {
    this.providers = providers;
  }

  public registerProvider(provider: BaseProvider) {
    this.providers.push(provider);
  }

  private requestIsMultimodal(request: ChatRequest): boolean {
    for (const msg of request.messages) {
      if (Array.isArray(msg.content)) {
        if (msg.content.some((block) => block.type === 'image')) return true;
      }
    }
    return false;
  }

  // Returns one entry per (provider, model) pair sorted by priority.
  // In flexible mode, only models of the same tier as the requested model are included.
  // When lockedTarget is set, only the exact locked provider+model is returned.
  private selectProviders(modelId: string, mode: 'strict' | 'flexible' = 'strict', multimodal: boolean = false, lockedTarget?: { providerName: string; providerModelId: string }): { provider: BaseProvider, config: any }[] {
    // Find the tier of the requested model (scan all providers)
    let requestedTier: string | undefined;
    for (const provider of this.providers) {
      const m = provider.config.models.find(m => m.id === modelId);
      if (m?.tier) { requestedTier = m.tier; break; }
    }

    const available: { provider: BaseProvider, config: any }[] = [];

    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;

      for (const modelConfig of provider.config.models) {
        if (lockedTarget) {
          if (provider.getName() !== lockedTarget.providerName) continue;
          if (modelConfig.providerModelId !== lockedTarget.providerModelId) continue;
        } else if (mode === 'strict') {
          if (modelConfig.id !== modelId) continue;
        } else {
          // flexible: exact id, or same-tier substitute when the model is known.
          // If no provider knows this modelId (requestedTier undefined), reject — don't
          // silently route an unknown model to an unrelated one.
          if (modelConfig.id !== modelId) {
            if (!requestedTier) continue;
            if (modelConfig.tier !== requestedTier) continue;
          }
        }

        // Skip text-only models for multimodal requests
        if (multimodal && modelConfig.capability === 'text') continue;

        if (!provider.hasAvailableKey(modelConfig.providerModelId)) continue;

        const limits: ProviderLimits = { rpm: provider.config.rpm ?? null, rpd: provider.config.rpd ?? null };
        if ((limits.rpm !== null || limits.rpd !== null) && !hasAvailableKeyForLimits(provider.getName(), modelConfig.providerModelId, provider.keyCount(), limits)) continue;

        available.push({ provider, config: modelConfig });
      }
    }

    available.sort((a, b) => {
      const rawA = a.config.priority ?? 99;
      const rawB = b.config.priority ?? 99;
      const pA = lockedTarget ? rawA : rawA + getPenalty(a.provider.getName(), a.config.providerModelId);
      const pB = lockedTarget ? rawB : rawB + getPenalty(b.provider.getName(), b.config.providerModelId);
      if (pA !== pB) return pA - pB;
      return b.provider.getScore(rawB) - a.provider.getScore(rawA);
    });

    return available;
  }

  public async routeChat(request: ChatRequest, mode: 'strict' | 'flexible' = 'strict', lockedTarget?: { providerName: string; providerModelId: string }, ctx?: RouteContext): Promise<ChatResponse> {
    const multimodal = this.requestIsMultimodal(request);
    const candidates = this.selectProviders(request.model, mode, multimodal, lockedTarget);
    if (candidates.length === 0) {
      if (lockedTarget) throw new Error(`Locked provider ${lockedTarget.providerName}:${lockedTarget.providerModelId} is not available`);
      throw new Error(`No healthy providers available for model: ${request.model}`);
    }

    const lockInfo = lockedTarget ? ` [locked: ${lockedTarget.providerName}:${lockedTarget.providerModelId}]` : '';
    console.log(`[Router] Routing request for ${request.model} (mode: ${mode}, multimodal: ${multimodal})${lockInfo}. Found ${candidates.length} candidates.`);

    let lastError: any;
    for (const candidate of candidates) {
      if (ctx) ctx.attempts++;
      const start = Date.now();
      const providerName = candidate.provider.getName();
      const providerModelId = candidate.config.providerModelId;
      try {
        console.log(`[Router] Attempting with ${providerName} (${providerModelId})...`);

        const response = await candidate.provider.chat(request, providerModelId);
        response.model = `${providerName.toLowerCase()}:${providerModelId}:v1`;

        const latencyMs = Date.now() - start;
        candidate.provider.recordSuccess(latencyMs);
        recordRequest(providerName, providerModelId, candidate.provider.lastKeyIndex);
        recordPenaltyDecay(providerName, providerModelId);
        console.log(`[Router] Success with ${providerName} in ${latencyMs}ms.`);

        logRequest({
          timestamp: new Date().toISOString(),
          requestModel: request.model,
          provider: providerName,
          providerModel: providerModelId,
          latencyMs,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          success: true,
          keyIndex: candidate.provider.lastKeyIndex,
          fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
        });

        return response;
      } catch (error: any) {
        const latencyMs = Date.now() - start;
        // Client-input errors (bad image URL, SSRF block, oversize) are not provider faults.
        // Surface immediately so the route layer can return 400. No health hit, no failover.
        if (error?.name === 'InvalidImageURLError') {
          logRequest({
            timestamp: new Date().toISOString(),
            requestModel: request.model,
            provider: providerName,
            providerModel: providerModelId,
            latencyMs,
            success: false,
            errorMessage: error.message,
            keyIndex: candidate.provider.lastKeyIndex,
            fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
          });
          throw error;
        }
        this.handleProviderError(candidate.provider, providerModelId, error);
        recordRequest(providerName, providerModelId, candidate.provider.lastKeyIndex);
        lastError = error;
        console.warn(`[Router] Provider ${providerName} failed: ${error.message}`);

        logRequest({
          timestamp: new Date().toISOString(),
          requestModel: request.model,
          provider: providerName,
          providerModel: providerModelId,
          latencyMs,
          success: false,
          errorMessage: error.message,
          keyIndex: typeof error.keyIndex === 'number' ? error.keyIndex : candidate.provider.lastKeyIndex,
          fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
        });

        // No failover when locked — fail immediately
        if (lockedTarget) throw new Error(`Locked provider ${providerName} failed: ${error.message}`);
      }
    }
    throw new Error(`All providers failed for model ${request.model}. Last error: ${lastError?.message}`);
  }

  public async *routeStreamChat(request: ChatRequest, mode: 'strict' | 'flexible' = 'strict', lockedTarget?: { providerName: string; providerModelId: string }, ctx?: RouteContext): AsyncIterable<StreamEvent> {
    const multimodal = this.requestIsMultimodal(request);
    const candidates = this.selectProviders(request.model, mode, multimodal, lockedTarget);
    if (candidates.length === 0) {
      const msg = lockedTarget
        ? `Locked provider ${lockedTarget.providerName}:${lockedTarget.providerModelId} is not available`
        : `No healthy providers available for model: ${request.model}`;
      yield { type: 'error', error: { type: 'overloaded_error', message: msg } };
      return;
    }

    const lockInfo = lockedTarget ? ` [locked: ${lockedTarget.providerName}:${lockedTarget.providerModelId}]` : '';
    console.log(`[Router] Routing stream request for ${request.model}${lockInfo}. Candidates: ${candidates.map(c => c.provider.getName()).join(', ')}`);

    let lastError: any;

    for (const candidate of candidates) {
      if (ctx) ctx.attempts++;
      const providerModelId = candidate.config.providerModelId;
      const providerName = candidate.provider.getName();
      const start = Date.now();
      let stream;
      let iterator;
      let firstResult;

      try {
        stream = candidate.provider.streamChat(request, providerModelId);
        iterator = stream[Symbol.asyncIterator]();
        firstResult = await iterator.next();

        if (firstResult.done) throw new Error('Empty stream');
      } catch (error: any) {
        this.handleProviderError(candidate.provider, providerModelId, error);
        recordRequest(providerName, providerModelId, candidate.provider.lastKeyIndex);
        lastError = error;
        logRequest({
          timestamp: new Date().toISOString(),
          requestModel: request.model,
          provider: providerName,
          providerModel: providerModelId,
          latencyMs: Date.now() - start,
          success: false,
          errorMessage: error.message,
          keyIndex: typeof error.keyIndex === 'number' ? error.keyIndex : candidate.provider.lastKeyIndex,
          fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
        });

        // No failover when locked — surface error immediately
        if (lockedTarget) {
          console.warn(`Locked provider ${providerName} stream failed:`, error.message);
          yield { type: 'error', error: { type: 'api_error', message: `Locked provider ${providerName} failed: ${error.message}` } };
          return;
        }

        console.warn(`Streaming failover from ${providerName} due to:`, error.message);
        continue;
      }

      // Connection succeeded — stream to client
      try {
        const firstValue = firstResult.value;
        if (firstValue.type === 'message_start' && firstValue.message) {
          firstValue.message.model = `${providerName.toLowerCase()}:${providerModelId}:v1`;
        }
        yield firstValue;

        while (true) {
          const { done, value } = await iterator.next();
          if (done) break;
          yield value;
        }

        const latencyMs = Date.now() - start;
        candidate.provider.recordSuccess(latencyMs);
        recordRequest(providerName, providerModelId, candidate.provider.lastKeyIndex);
        recordPenaltyDecay(providerName, providerModelId);

        logRequest({
          timestamp: new Date().toISOString(),
          requestModel: request.model,
          provider: providerName,
          providerModel: providerModelId,
          latencyMs,
          success: true,
          keyIndex: candidate.provider.lastKeyIndex,
          fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
        });

        return;
      } catch (streamError: any) {
        // Mid-stream error (stall timeout, network drop) — log and surface to client
        this.handleProviderError(candidate.provider, providerModelId, streamError);
        recordRequest(providerName, providerModelId, candidate.provider.lastKeyIndex);
        logRequest({
          timestamp: new Date().toISOString(),
          requestModel: request.model,
          provider: providerName,
          providerModel: providerModelId,
          latencyMs: Date.now() - start,
          success: false,
          errorMessage: streamError.message,
          keyIndex: typeof streamError.keyIndex === 'number' ? streamError.keyIndex : candidate.provider.lastKeyIndex,
          fallbackAttempts: ctx ? Math.max(0, ctx.attempts - 1) : undefined,
        });
        yield { type: 'error', error: { type: 'api_error', message: `Stream failed mid-flight: ${streamError.message}` } };
        return;
      }
    }

    yield { type: 'error', error: { type: 'api_error', message: `All providers failed to stream. Last error: ${lastError?.message}` } };
  }

  private handleProviderError(provider: BaseProvider, modelId: string, error: any) {
    // NoAvailableKeyError means all keys were already filtered out (cooldown or rate-limit).
    // It's not a real upstream failure — don't penalize the provider's health.
    if (error?.name === 'NoAvailableKeyError') return;
    const msg = error.message || '';
    const isRateLimit = msg.includes('429') || msg.includes('Quota Exceeded');
    // AbortError = our own timeout; stall timeout = named error message
    const isTimeout = error.name === 'AbortError' || msg.includes('stall timeout');
    const isServerError = isTimeout || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504');
    const keyIndex = typeof error.keyIndex === 'number' ? error.keyIndex : 0;
    provider.recordFailure(modelId, keyIndex, isRateLimit, isServerError);
    if (isRateLimit) {
      recordRateLimitHit(provider.getName(), modelId);
    }
  }
}
