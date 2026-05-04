import { ProviderConfig } from '../types';
import { EncryptionUtil } from '../utils/encryption';
import { config as envConfig } from './env';

// In a real app, API keys should be encrypted in a DB or secure JSON.
// For demonstration, we'll assume they are stored in environment variables,
// but the architecture calls for AES-256-GCM encryption.

export function getProvidersConfig(): ProviderConfig[] {
  const masterKey = envConfig.masterKey!;
  
  const decryptIfNeeded = (key: string | undefined, providerName: string) => {
    if (!key) throw new Error(`Missing API Key for ${providerName}`);
    
    // Check if it's in the encrypted format: salt:iv:authTag:encryptedText
    if (key.includes(':') && key.split(':').length === 4) {
      try {
        return EncryptionUtil.decrypt(key, masterKey);
      } catch (e) {
        console.warn(`Warning: Failed to decrypt API key for ${providerName}. Using as plain text.`);
        return key;
      }
    }
    
    // If not in encrypted format, assume it's a plain text key
    return key;
  };

  return [
    {
      name: 'Google',
      apiKey: decryptIfNeeded(process.env.GOOGLE_API_KEY, 'Google'),
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
      apiKey: decryptIfNeeded(process.env.GROQ_API_KEY, 'Groq'),
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
