import { BaseProvider } from './base';
import { ChatRequest, ChatResponse, ProviderConfig, MessageContent, StreamEvent } from '../types';

export class OpenAILikeProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private translateRequest(request: ChatRequest, stream: boolean = false) {
    const messages: any[] = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }

    for (const msg of request.messages) {
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else {
        text = msg.content.map((c: MessageContent) => c.text).join('\n');
      }
      messages.push({ role: msg.role, content: text });
    }

    return {
      model: request.model, // will be replaced by mappedModelId in call
      messages,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream
    };
  }

  async chat(request: ChatRequest, mappedModelId: string): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = { ...this.translateRequest(request), model: mappedModelId };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) throw new Error('429');
        if (response.status >= 500) throw new Error('500');
        const errText = await response.text();
        throw new Error(`${this.getName()} API error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      const textResponse = data.choices?.[0]?.message?.content || '';
      
      return {
        id: data.id || `msg_${this.getName()}_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: mappedModelId,
        content: [{ type: 'text', text: textResponse }],
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0
        }
      };
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }

  async *streamChat(request: ChatRequest, mappedModelId: string): AsyncIterable<StreamEvent> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = { ...this.translateRequest(request, true), model: mappedModelId };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      if (response.status === 429) throw new Error('429');
      if (response.status >= 500) throw new Error('500');
      throw new Error(`${this.getName()} Stream Error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    yield {
      type: 'message_start',
      message: {
        id: `msg_oa_${Date.now()}`,
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
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const text = json.choices?.[0]?.delta?.content;
              if (text) {
                yield {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text }
                };
              }
            } catch (e) {}
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
