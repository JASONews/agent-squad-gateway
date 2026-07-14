import { z } from 'zod';

const initEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  tools: z.array(z.unknown()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  slash_commands: z.array(z.unknown()).optional(),
  skills: z.array(z.unknown()).optional(),
  agents: z.array(z.unknown()).optional(),
  plugins: z.array(z.unknown()).optional(),
  permissionMode: z.string().optional(),
});

const streamEventSchema = z.object({
  type: z.literal('stream_event'),
  session_id: z.string().min(1).optional(),
  event: z.unknown(),
});

const assistantEventSchema = z.object({
  type: z.literal('assistant'),
  session_id: z.string().min(1).optional(),
  message: z.unknown(),
});

const resultEventSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string().min(1),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

const rawClaudeEventSchema = z.discriminatedUnion('type', [
  initEventSchema,
  streamEventSchema,
  assistantEventSchema,
  resultEventSchema,
]);

const textDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  delta: z.object({
    type: z.literal('text_delta'),
    text: z.string(),
  }),
});

const contentBlockStartSchema = z.object({
  type: z.literal('content_block_start'),
  content_block: z.object({ type: z.string() }).passthrough(),
}).passthrough();

const ignoredStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start') }).passthrough(),
  z.object({ type: z.literal('content_block_stop') }).passthrough(),
  z.object({ type: z.literal('message_delta') }).passthrough(),
  z.object({ type: z.literal('message_stop') }).passthrough(),
]);

const assistantMessageSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()),
}).passthrough();

export type ClaudeEvent =
  | z.infer<typeof initEventSchema>
  | {
      type: 'stream_event';
      session_id?: string;
      event: {
        type: 'content_block_delta';
        delta: { type: 'text_delta'; text: string };
      };
    }
  | z.infer<typeof assistantEventSchema>
  | z.infer<typeof resultEventSchema>;

export class ClaudeAdapterError extends Error {
  constructor(readonly code: 'adapter_protocol_error' | 'adapter_capability_unsupported') {
    super(code);
    this.name = 'ClaudeAdapterError';
  }
}

function protocolError(): never {
  throw new ClaudeAdapterError('adapter_protocol_error');
}

function isEmpty(value: unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length === 0;
}

export function hasStrictIsolationEvidence(event: Extract<ClaudeEvent, { type: 'system' }>): boolean {
  return isEmpty(event.tools)
    && isEmpty(event.mcp_servers)
    && isEmpty(event.slash_commands)
    && isEmpty(event.skills)
    && isEmpty(event.agents)
    && isEmpty(event.plugins)
    && event.permissionMode === 'dontAsk';
}

function assertEmptyCustomization(event: z.infer<typeof initEventSchema>): void {
  for (const value of [
    event.tools,
    event.mcp_servers,
    event.slash_commands,
    event.skills,
    event.agents,
    event.plugins,
  ]) {
    if (value && value.length > 0) protocolError();
  }
}

function assertSafeAssistantMessage(message: unknown): void {
  const parsed = assistantMessageSchema.safeParse(message);
  if (!parsed.success) protocolError();
  for (const block of parsed.data.content) {
    if (block.type !== 'text') protocolError();
  }
}

export function parseClaudeEvent(line: string): ClaudeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    protocolError();
  }

  const parsed = rawClaudeEventSchema.safeParse(value);
  if (!parsed.success) protocolError();
  const event = parsed.data;

  if (event.type === 'system') {
    assertEmptyCustomization(event);
    return event;
  }
  if (event.type === 'assistant') {
    assertSafeAssistantMessage(event.message);
    return event;
  }
  if (event.type === 'result') return event;

  const delta = textDeltaSchema.safeParse(event.event);
  if (delta.success) {
    return {
      type: 'stream_event',
      ...(event.session_id ? { session_id: event.session_id } : {}),
      event: delta.data,
    };
  }

  const blockStart = contentBlockStartSchema.safeParse(event.event);
  if (blockStart.success) {
    if (blockStart.data.content_block.type !== 'text') protocolError();
    return null;
  }
  if (ignoredStreamEventSchema.safeParse(event.event).success) return null;
  return protocolError();
}
