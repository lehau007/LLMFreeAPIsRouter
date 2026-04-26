import { ProviderConfig } from '../types';
import { EncryptionUtil } from '../utils/encryption';
import { config as envConfig } from './env';

// In a real app, API keys should be encrypted in a DB or secure JSON.
// For demonstration, we'll assume they are stored in environment variables,
// but the architecture calls for AES-256-GCM encryption.

export function getProvidersConfig(): ProviderConfig[] {
  const masterKey = envConfig.masterKey!;
  
  const decryptIfNeeded = (key: string) => {
    // Basic check to see if it's an encrypted format (contains parts)
    if (key.includes(':') && key.split(':').length === 4) {
      try {
        return EncryptionUtil.decrypt(key, masterKey);
      } catch (e) {
        console.error('Failed to decrypt API key. Using as-is.');
        return key;
      }
    }
    return key;
  };

  return [
    {
      name: 'Google',
      apiKey: decryptIfNeeded(process.env.GOOGLE_API_KEY || 'dummy_key'),
      models: [
        {
          id: 'claude-3-haiku-20240307', 
          providerModelId: 'gemini-1.5-flash',
          priority: 2
        },
        {
          id: 'claude-3-sonnet-20240229',
          providerModelId: 'gemini-1.5-pro',
          priority: 2
        },
        {
          id: 'gemini-1.5-pro',
          providerModelId: 'gemini-1.5-pro',
          priority: 1
        }
      ]
    },
    {
      name: 'Groq',
      apiKey: decryptIfNeeded(process.env.GROQ_API_KEY || 'dummy_key'),
      models: [
        {
          id: 'claude-3-haiku-20240307',
          providerModelId: 'llama-3.3-70b-versatile',
          priority: 1
        }
      ]
    }
  ];
}
