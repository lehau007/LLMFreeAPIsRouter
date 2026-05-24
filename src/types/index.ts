export interface MessageContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type AnyContent = MessageContent | ImageContent;

export interface Message {
  role: 'user' | 'assistant';
  content: string | AnyContent[];
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  system?: string;
  max_tokens: number; // Required in Anthropic
  temperature?: number;
  stream?: boolean;
}

export interface ChatResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: MessageContent[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Anthropic Streaming Types
export type StreamEventType = 
  | 'message_start' 
  | 'content_block_start' 
  | 'content_block_delta' 
  | 'content_block_stop' 
  | 'message_delta' 
  | 'message_stop' 
  | 'ping' 
  | 'error';

export interface StreamEvent {
  type: StreamEventType;
  message?: Partial<ChatResponse>;
  index?: number;
  content_block?: any;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
    usage?: {
      output_tokens: number;
    };
  };
  usage?: {
    output_tokens: number;
  };
  error?: {
    type: string;
    message: string;
  };
}

export interface ModelConfig {
  id: string;
  providerModelId: string;
  priority?: number;
  weight?: number;
  capability?: 'text' | 'multimodal';
  tier?: 'fast' | 'balanced' | 'powerful';
}

export interface ProviderConfig {
  name: string;
  baseUrl?: string;
  apiKeys: string[];
  models: ModelConfig[];
  timeoutMs?: number;
  rpm?: number | null;
  rpd?: number | null;
}
