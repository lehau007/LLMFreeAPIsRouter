import { BaseProvider, NoAvailableKeyError } from './base';
import { AnyContent, ChatRequest, ChatResponse, ImageContent, MessageContent, ProviderConfig, StreamEvent } from '../types';

const STREAM_STALL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 30000;

function contentBlockToOpenAIPart(block: AnyContent): any {
  if (block.type === 'text') return { type: 'text', text: (block as MessageContent).text };
  const img = block as ImageContent;
  const url = img.source.type === 'base64'
    ? `data:${img.source.media_type || 'image/jpeg'};base64,${img.source.data}`
    : img.source.url!;
  return { type: 'image_url', image_url: { url } };
}

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
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else {
        const hasImage = msg.content.some(c => c.type === 'image');
        if (hasImage) {
          // Vision: pass as content array with image_url blocks
          messages.push({ role: msg.role, content: msg.content.map(contentBlockToOpenAIPart) });
        } else {
          // Text-only: flatten to string
          messages.push({ role: msg.role, content: msg.content.map(c => (c as MessageContent).text).join('\n') });
        }
      }
    }

    return {
      model: request.model,
      messages,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream
    };
  }

  async chat(request: ChatRequest, mappedModelId: string): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = { ...this.translateRequest(request), model: mappedModelId };
    const picked = this.nextKey(mappedModelId);
    if (!picked) throw new NoAvailableKeyError(this.getName(), mappedModelId);
    const { key, index: keyIndex } = picked;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
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
      // success path continues below

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
      error.keyIndex = keyIndex;
      throw error;
    }
  }

  async *streamChat(request: ChatRequest, mappedModelId: string): AsyncIterable<StreamEvent> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = { ...this.translateRequest(request, true), model: mappedModelId };
    const picked = this.nextKey(mappedModelId);
    if (!picked) throw new NoAvailableKeyError(this.getName(), mappedModelId);
    const { key, index: keyIndex } = picked;

    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), this.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(connectTimeout);

      if (!response.ok) {
        if (response.status === 429) throw new Error('429');
        if (response.status >= 500) throw new Error('500');
        throw new Error(`${this.getName()} Stream Error: ${response.status}`);
      }
    } catch (error: any) {
      clearTimeout(connectTimeout);
      error.keyIndex = keyIndex;
      throw error;
    }

    const reader = response.body?.getReader();
    if (!reader) { const e: any = new Error('No response body'); e.keyIndex = keyIndex; throw e; }

    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;

    const readOne = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Stream stall timeout')), STREAM_STALL_MS);
        reader.read().then(r => { clearTimeout(t); resolve(r); }).catch(err => { clearTimeout(t); reject(err); });
      });

    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await readOne();
        } catch (err: any) {
          // Pre-commit failures attach keyIndex so the router can failover transparently.
          if (!started) err.keyIndex = keyIndex;
          throw err;
        }
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          let text: string | undefined;
          try {
            text = JSON.parse(trimmed.slice(6)).choices?.[0]?.delta?.content;
          } catch {}
          if (!text) continue;
          if (!started) {
            started = true;
            yield {
              type: 'message_start',
              message: { id: `msg_oa_${Date.now()}`, type: 'message', role: 'assistant', model: mappedModelId, content: [] }
            };
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        }
      }
      if (!started) {
        const e: any = new Error('Empty stream (no text before EOF)');
        e.keyIndex = keyIndex;
        throw e;
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }
}
