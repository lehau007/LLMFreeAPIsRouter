import { BaseProvider } from '../providers/base';
import { ChatRequest, ChatResponse, StreamEvent } from '../types';

export class Router {
  private providers: BaseProvider[] = [];

  constructor(providers: BaseProvider[]) {
    this.providers = providers;
  }

  public registerProvider(provider: BaseProvider) {
    this.providers.push(provider);
  }

  private selectProviders(modelId: string, mode: 'strict' | 'flexible' = 'strict'): { provider: BaseProvider, config: any }[] {
    const available = [];

    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;

      const modelConfig = provider.config.models.find(m => m.id === modelId);
      if (modelConfig) {
        available.push({ provider, config: modelConfig });
      }
    }

    available.sort((a, b) => {
      const pA = a.config.priority ?? 99;
      const pB = b.config.priority ?? 99;
      if (pA !== pB) return pA - pB;
      return b.provider.getScore(pB) - a.provider.getScore(pA);
    });

    return available;
  }

  public async routeChat(request: ChatRequest, mode: 'strict' | 'flexible' = 'strict'): Promise<ChatResponse> {
    const candidates = this.selectProviders(request.model, mode);
    if (candidates.length === 0) throw new Error(`No healthy providers available for model: ${request.model}`);

    console.log(`[Router] Routing request for ${request.model} (mode: ${mode}). Found ${candidates.length} candidates.`);

    let lastError: any;
    for (const candidate of candidates) {
      const start = Date.now();
      const providerName = candidate.provider.getName();
      try {
        const providerModelId = candidate.config.providerModelId;
        console.log(`[Router] Attempting with ${providerName} (${providerModelId})...`);
        
        const response = await candidate.provider.chat(request, providerModelId);
        
        const duration = Date.now() - start;
        candidate.provider.recordSuccess(duration);
        console.log(`[Router] Success with ${providerName} in ${duration}ms.`);
        
        return response;
      } catch (error: any) {
        this.handleProviderError(candidate.provider, error);
        lastError = error;
        console.warn(`[Router] Provider ${providerName} failed: ${error.message}`);
      }
    }
    throw new Error(`All providers failed for model ${request.model}. Last error: ${lastError?.message}`);
  }

  public async *routeStreamChat(request: ChatRequest, mode: 'strict' | 'flexible' = 'strict'): AsyncIterable<StreamEvent> {
    const candidates = this.selectProviders(request.model, mode);
    if (candidates.length === 0) {
      yield { type: 'error', error: { type: 'overloaded_error', message: `No healthy providers available for model: ${request.model}` } };
      return;
    }

    console.log(`[Router] Routing stream request for ${request.model}. Candidates: ${candidates.map(c => c.provider.getName()).join(', ')}`);

    // We only try failover for the initial connection in streaming
    for (const candidate of candidates) {
      try {
        const providerModelId = candidate.config.providerModelId;
        const stream = candidate.provider.streamChat(request, providerModelId);
        
        // Try to get the first event to see if connection is OK
        const iterator = stream[Symbol.asyncIterator]();
        const firstResult = await iterator.next();
        
        if (firstResult.done) throw new Error('Empty stream');
        
        // If we got here, connection started successfully
        yield firstResult.value;
        
        // Yield the rest
        while (true) {
          const { done, value } = await readerNext(iterator);
          if (done) break;
          yield value;
        }
        
        candidate.provider.recordSuccess(100); // Placeholder latency
        return; // Success
      } catch (error: any) {
        this.handleProviderError(candidate.provider, error);
        lastError = error;
        console.warn(`Streaming failover from ${candidate.provider.getName()} due to:`, error.message);
      }
    }
    
    yield { type: 'error', error: { type: 'api_error', message: `All providers failed to stream. Last error: ${lastError?.message}` } };
  }

  private handleProviderError(provider: BaseProvider, error: any) {
    const isRateLimit = error.message.includes('429');
    const isServerError = error.message.includes('500');
    provider.recordFailure(isRateLimit, isServerError);
  }
}

// Helper to handle iterator next
async function readerNext(iterator: AsyncGenerator | AsyncIterator<any>) {
  return await iterator.next();
}
