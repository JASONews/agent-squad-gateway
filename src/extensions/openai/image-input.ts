import { providerSupportsImageInput } from '../../provider-runtime/image-support.js';
import type {
  ProviderImageSource,
  ProviderInputItem,
} from '../../provider-runtime/types.js';
import { OpenAIError } from './errors.js';
import type { ChatMessage, ResponsesRequest } from './schemas.js';
import {
  normalizeChatToolRoundTrip,
  normalizeResponsesToolRoundTrip,
  ToolInputError,
} from './tools.js';

export interface NormalizedProviderInput {
  input: ProviderInputItem[];
  images: ProviderImageSource[];
}

function invalidRequest(): OpenAIError {
  return new OpenAIError(400, 'Invalid request', 'invalid_request_error', null, 'invalid_request');
}

function imagePlaceholder(index: number): string {
  return `\n[Attached image #${index}]\n`;
}

function appendPart(output: string[], value: string): void {
  if (value.length === 0) return;
  output.push(value);
}

export function assertImageInputSupported(
  cli: string,
  images: ProviderImageSource[],
  param: 'messages' | 'input',
): void {
  if (images.length === 0 || providerSupportsImageInput(cli)) return;
  throw new OpenAIError(
    400,
    'The selected model does not support image input',
    'invalid_request_error',
    param,
    'image_input_not_supported',
  );
}

export function normalizeChatInput(messages: ChatMessage[]): NormalizedProviderInput {
  const images: ProviderImageSource[] = [];
  const normalized = messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;
    const content: string[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        appendPart(content, part.text);
        continue;
      }
      images.push({
        url: part.image_url.url,
        detail: part.image_url.detail ?? 'auto',
      });
      appendPart(content, imagePlaceholder(images.length));
    }
    return { ...message, content: content.join('') };
  });

  try {
    return { input: normalizeChatToolRoundTrip(normalized), images };
  } catch (error) {
    if (error instanceof ToolInputError) throw invalidRequest();
    throw error;
  }
}

export function normalizeResponsesInput(
  request: ResponsesRequest,
  expectedCalls?: ReadonlySet<string>,
): NormalizedProviderInput {
  if (typeof request.input === 'string') {
    return { input: [{ role: 'user', content: request.input }], images: [] };
  }

  const images: ProviderImageSource[] = [];
  const normalized = request.input.map((item) => {
    if (!('role' in item) || item.role !== 'user' || typeof item.content === 'string') return item;
    const content: string[] = [];
    for (const part of item.content) {
      if (part.type === 'input_text') {
        appendPart(content, part.text);
        continue;
      }
      images.push({ url: part.image_url, detail: part.detail ?? 'auto' });
      appendPart(content, imagePlaceholder(images.length));
    }
    return { ...item, content: content.join('') };
  });

  try {
    return {
      input: normalizeResponsesToolRoundTrip(normalized, expectedCalls),
      images,
    };
  } catch (error) {
    if (error instanceof ToolInputError) throw invalidRequest();
    throw error;
  }
}
