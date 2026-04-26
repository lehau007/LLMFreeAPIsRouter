import { OpenAILikeProvider } from './openai-like';
import { ProviderConfig } from '../types';

export class OpenRouterProvider extends OpenAILikeProvider {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1'
    });
  }
}
