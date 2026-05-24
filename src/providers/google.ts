import { BaseProvider, NoAvailableKeyError } from './base';
import { AnyContent, ChatRequest, ChatResponse, ImageContent, ProviderConfig, StreamEvent } from '../types';
import { safeFetchImage } from '../utils/safeFetch';

const STREAM_STALL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 30000;

function contentBlockToGeminiPart(block: AnyContent): Promise<any> | any {
  if (block.type === 'text') return { text: block.text };
  const img = block as ImageContent;
  if (img.source.type === 'base64') {
    return { inlineData: { mimeType: img.source.media_type || 'image/jpeg', data: img.source.data! } };
  }
  // URL: validate (block private IPs / redirects / non-image MIME / oversize) and inline as base64.
  return safeFetchImage(img.source.url!).then(({ mimeType, data }) => ({ inlineData: { mimeType, data } }));
}

export class GoogleProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
    if (!this.config.baseUrl) {
      this.config.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    }
  }

  private async translateRequest(request: ChatRequest) {
    const contents = await Promise.all(request.messages.map(async msg => {
      let parts: any[];
      if (typeof msg.content === 'string') {
        parts = [{ text: msg.content }];
      } else {
        parts = await Promise.all(msg.content.map(contentBlockToGeminiPart));
      }
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts
      };
    }));

    const body: any = { contents };

    if (request.system) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }

    if (request.temperature !== undefined || request.max_tokens !== undefined) {
      body.generationConfig = {};
      if (request.temperature !== undefined) body.generationConfig.temperature = request.temperature;
      if (request.max_tokens !== undefined) body.generationConfig.maxOutputTokens = request.max_tokens;
    }
    return body;
  }

  async chat(request: ChatRequest, mappedModelId: string): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/${mappedModelId}:generateContent`;
    const body = await this.translateRequest(request);
    const picked = this.nextKey(mappedModelId);
    if (!picked) throw new NoAvailableKeyError(this.getName(), mappedModelId);
    const { key, index: keyIndex } = picked;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 429) throw new Error('429');
        if (response.status >= 500) throw new Error(`500: ${errText}`);
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
      error.keyIndex = keyIndex;
      throw error;
    }
  }

  async *streamChat(request: ChatRequest, mappedModelId: string): AsyncIterable<StreamEvent> {
    const url = `${this.config.baseUrl}/${mappedModelId}:streamGenerateContent?alt=sse`;
    const body = await this.translateRequest(request);
    const picked = this.nextKey(mappedModelId);
    if (!picked) throw new NoAvailableKeyError(this.getName(), mappedModelId);
    const { key, index: keyIndex } = picked;

    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), this.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(connectTimeout);

      if (!response.ok) {
        if (response.status === 429) throw new Error('429');
        if (response.status >= 500) throw new Error('500');
        throw new Error(`Google Stream Error: ${response.status}`);
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
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') break;
          let text: string | undefined;
          try {
            text = JSON.parse(dataStr).candidates?.[0]?.content?.parts?.[0]?.text;
          } catch {}
          if (!text) continue;
          if (!started) {
            started = true;
            yield {
              type: 'message_start',
              message: { id: `msg_google_st_${Date.now()}`, type: 'message', role: 'assistant', model: mappedModelId, content: [] }
            };
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        }
      }
      if (!started) {
        // Stream closed before any token — surface as a pre-commit failure for failover.
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
