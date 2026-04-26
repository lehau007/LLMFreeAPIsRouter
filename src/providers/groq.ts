import { OpenAILikeProvider } from './openai-like';
import { ProviderConfig } from '../types';

export class GroqProvider extends OpenAILikeProvider {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1'
    });
  }
}
