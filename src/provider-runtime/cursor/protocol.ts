import { z } from 'zod';

const initEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
}).passthrough();

const userEventSchema = z.object({
  type: z.literal('user'),
  session_id: z.string().min(1),
  message: z.unknown(),
}).passthrough();

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const assistantEventSchema = z.object({
  type: z.literal('assistant'),
  session_id: z.string().min(1),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(textBlockSchema).min(1),
  }).passthrough(),
  timestamp_ms: z.number().int().optional(),
}).passthrough();

const thinkingEventSchema = z.object({
  type: z.literal('thinking'),
  subtype: z.enum(['delta', 'completed']),
  session_id: z.string().min(1),
  text: z.string().optional(),
  timestamp_ms: z.number().int().optional(),
}).passthrough();

const toolCallEventSchema = z.object({
  type: z.literal('tool_call'),
  subtype: z.string(),
  session_id: z.string().min(1),
  call_id: z.string().optional(),
  tool_call: z.unknown(),
}).passthrough();

const resultEventSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  session_id: z.string().min(1),
  result: z.string().optional(),
}).passthrough();

const cursorEventSchema = z.discriminatedUnion('type', [
  initEventSchema,
  userEventSchema,
  thinkingEventSchema,
  assistantEventSchema,
  toolCallEventSchema,
  resultEventSchema,
]);

export type CursorEvent = z.infer<typeof cursorEventSchema>;

export class CursorAdapterError extends Error {
  constructor(readonly code: 'adapter_protocol_error' | 'adapter_capability_unsupported') {
    super(code);
    this.name = 'CursorAdapterError';
  }
}

export function parseCursorEvent(line: string): CursorEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CursorAdapterError('adapter_protocol_error');
  }
  const parsed = cursorEventSchema.safeParse(value);
  if (!parsed.success) throw new CursorAdapterError('adapter_protocol_error');
  return parsed.data;
}

export function cursorAssistantText(
  event: Extract<CursorEvent, { type: 'assistant' }>,
): string {
  return event.message.content.map((block) => block.text).join('');
}
