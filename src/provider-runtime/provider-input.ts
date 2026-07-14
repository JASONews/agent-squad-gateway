import type { ProviderInputItem, ProviderInputToolCall } from './types.js';

export const API_PROVIDER_SYSTEM_INSTRUCTION = [
  'You are responding through Agent Squad Gateway as an API model provider.',
  'Do not use native tools, shell commands, files, browsers, MCP servers, skills, plugins, hooks, agents, or external integrations.',
  'Use only the supplied conversation and return only the requested assistant text or schema-constrained JSON.',
].join(' ');

class ProviderInputError extends Error {
  readonly code = 'adapter_protocol_error';

  constructor() {
    super('adapter_protocol_error');
    this.name = 'ProviderInputError';
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function canonicalToolCall(call: ProviderInputToolCall): ProviderInputToolCall {
  if (typeof call.id !== 'string' || call.id.length === 0
    || typeof call.name !== 'string' || call.name.length === 0
    || call.arguments === null || typeof call.arguments !== 'object'
    || Array.isArray(call.arguments)) {
    throw new ProviderInputError();
  }
  return {
    id: call.id,
    name: call.name,
    arguments: canonicalValue(call.arguments) as Record<string, unknown>,
  };
}

function textBlock(role: 'system' | 'user' | 'assistant', content: string): string {
  if (typeof content !== 'string') throw new ProviderInputError();
  return `<${role}>${escapeText(content)}</${role}>`;
}

export function renderProviderInput(input: ProviderInputItem[]): string {
  if (!Array.isArray(input)) throw new ProviderInputError();
  const blocks: string[] = [];

  for (const item of input) {
    if (item.role === 'tool') {
      if (typeof item.toolCallId !== 'string' || item.toolCallId.length === 0
        || typeof item.content !== 'string') {
        throw new ProviderInputError();
      }
      blocks.push(
        `<tool_result call_id="${escapeAttribute(item.toolCallId)}">${escapeText(item.content)}</tool_result>`,
      );
      continue;
    }

    if (item.role !== 'system' && item.role !== 'user' && item.role !== 'assistant') {
      throw new ProviderInputError();
    }

    if ('toolCalls' in item) {
      if (item.role !== 'assistant' || !Array.isArray(item.toolCalls) || item.toolCalls.length === 0) {
        throw new ProviderInputError();
      }
      if (item.content !== null) blocks.push(textBlock('assistant', item.content));
      const calls = item.toolCalls.map(canonicalToolCall);
      blocks.push(`<assistant_tool_calls>${escapeText(JSON.stringify(calls))}</assistant_tool_calls>`);
      continue;
    }

    blocks.push(textBlock(item.role, item.content));
  }

  return blocks.join('\n\n');
}
