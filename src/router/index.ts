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
      } else if (mode === 'flexible' && provider.config.models.length > 0) {
        const fallbackConfig = [...provider.config.models].sort((a,b) => (a.priority ?? 99) - (b.priority ?? 99))[0];
        available.push({ provider, config: fallbackConfig });
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
        response.model = `${providerName.toLowerCase()}:${providerModelId}:v1`;
        
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

    let lastError: any;

    for (const candidate of candidates) {
      const providerModelId = candidate.config.providerModelId;
      let stream;
      let iterator;
      let firstResult;
      
      try {
        stream = candidate.provider.streamChat(request, providerModelId);
        iterator = stream[Symbol.asyncIterator]();
        firstResult = await iterator.next();
        
        if (firstResult.done) throw new Error('Empty stream');
      } catch (error: any) {
        this.handleProviderError(candidate.provider, error);
        lastError = error;
        console.warn(`Streaming failover from ${candidate.provider.getName()} due to:`, error.message);
        continue;
      }
      
      // Connection succeeded
      try {
        const firstValue = firstResult.value;
        if (firstValue.type === 'message_start' && firstValue.message) {
          firstValue.message.model = `${candidate.provider.getName().toLowerCase()}:${providerModelId}:v1`;
        }
        yield firstValue;
        
        while (true) {
          const { done, value } = await iterator.next();
          if (done) break;
          yield value;
        }
        candidate.provider.recordSuccess(100); // Placeholder latency
        return; // Success
      } catch (streamError: any) {
        yield { type: 'error', error: { type: 'api_error', message: `Stream failed mid-flight: ${streamError.message}` } };
        return; // Fail-fast mid-stream
      }
    }
    
    yield { type: 'error', error: { type: 'api_error', message: `All providers failed to stream. Last error: ${lastError?.message}` } };
  }

  private handleProviderError(provider: BaseProvider, error: any) {
    const msg = error.message || '';
    const isRateLimit = msg.includes('429') || msg.includes('Quota Exceeded');
    const isServerError = msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('reset');
    provider.recordFailure(isRateLimit, isServerError);
  }
}

// Removed unused readerNext
