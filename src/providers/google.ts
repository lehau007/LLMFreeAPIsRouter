import { BaseProvider } from './base';
import { ChatRequest, ChatResponse, ProviderConfig, StreamEvent } from '../types';

export class GoogleProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
    if (!this.config.baseUrl) {
      this.config.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    }
  }

  private translateRequest(request: ChatRequest) {
    const contents = request.messages.map(msg => {
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else {
        text = msg.content.map(c => c.text).join('\n');
      }
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }]
      };
    });

    const body: any = { contents };

    if (request.system) {
      body.systemInstruction = {
        parts: [{ text: request.system }]
      };
    }

    if (request.temperature !== undefined || request.max_tokens !== undefined) {
      body.generationConfig = {};
      if (request.temperature !== undefined) body.generationConfig.temperature = request.temperature;
      if (request.max_tokens !== undefined) body.generationConfig.maxOutputTokens = request.max_tokens;
    }
    return body;
  }

  async chat(request: ChatRequest, mappedModelId: string): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/${mappedModelId}:generateContent?key=${this.config.apiKey}`;
    const body = this.translateRequest(request);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) throw new Error('429');
        if (response.status >= 500) throw new Error('500');
        const errText = await response.text();
        throw new Error(`Google API error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      return {
        id: `msg_google_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: mappedModelId,
        content: [{ type: 'text', text: textResponse }],
        usage: {
          input_tokens: data.usageMetadata?.promptTokenCount || 0,
          output_tokens: data.usageMetadata?.candidatesTokenCount || 0
        }
      };
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }

  async *streamChat(request: ChatRequest, mappedModelId: string): AsyncIterable<StreamEvent> {
    const url = `${this.config.baseUrl}/${mappedModelId}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;
    const body = this.translateRequest(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      if (response.status === 429) throw new Error('429');
      if (response.status >= 500) throw new Error('500');
      throw new Error(`Google Stream Error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    // Anthropic-like initial event
    yield {
      type: 'message_start',
      message: {
        id: `msg_google_st_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: mappedModelId,
        content: []
      }
    };

    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;
            try {
              const json = JSON.parse(dataStr);
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text }
                };
              }
            } catch (e) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }
}
