import { z } from 'zod';

const FunctionCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.string(),
}).strict();

const ChatTextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).strict();

const ChatImageUrlContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }).strict(),
}).strict();

const ChatTextContentSchema = z.union([
  z.string(),
  z.array(ChatTextContentPartSchema).min(1),
]).transform((content) => (
  typeof content === 'string' ? content : content.map((part) => part.text).join('')
));

export const ChatToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: FunctionCallSchema,
}).strict();

const TextMessageSchema = z.object({
  role: z.enum(['system', 'assistant']),
  content: ChatTextContentSchema,
}).strict();

const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.string(),
    z.array(z.union([
      ChatTextContentPartSchema,
      ChatImageUrlContentPartSchema,
    ])).min(1),
  ]),
}).strict();

const AssistantToolMessageSchema = z.object({
  role: z.literal('assistant'),
  content: ChatTextContentSchema.nullable().optional(),
  tool_calls: z.array(ChatToolCallSchema).min(1),
}).strict();

const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  tool_call_id: z.string().min(1),
  content: ChatTextContentSchema,
}).strict();

export const ChatMessageSchema = z.union([
  TextMessageSchema,
  UserMessageSchema,
  AssistantToolMessageSchema,
  ToolMessageSchema,
]);

const FunctionToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
}).strict();

export const FunctionToolSchema = z.object({
  type: z.literal('function'),
  function: FunctionToolDefinitionSchema,
}).strict();

const SpecificToolChoiceSchema = z.object({
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1) }).strict(),
}).strict();

const ChatStopSchema = z.union([
  z.string(),
  z.array(z.string()).max(4),
]);

const ChatStreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
}).strict();

const TextResponseFormatSchema = z.object({
  type: z.literal('text'),
}).strict();

export const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: ChatStreamOptionsSchema.nullable().optional(),
  tools: z.array(FunctionToolSchema).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.literal('required'),
    SpecificToolChoiceSchema,
  ]).optional(),
  // Coding CLIs do not expose portable sampling controls. These validated fields are accepted as
  // compatibility hints for OpenAI clients such as LiteLLM, but are not forwarded to providers.
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  n: z.literal(1).nullable().optional(),
  frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
  presence_penalty: z.number().min(-2).max(2).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  stop: ChatStopSchema.nullable().optional(),
  response_format: TextResponseFormatSchema.nullable().optional(),
  store: z.literal(false).nullable().optional(),
  user: z.string().nullable().optional(),
}).strict();

const ResponsesTextMessageSchema = z.object({
  role: z.enum(['system', 'assistant']),
  content: z.string(),
}).strict();

const ResponsesInputTextPartSchema = z.object({
  type: z.literal('input_text'),
  text: z.string(),
}).strict();

const ResponsesInputImagePartSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().min(1),
  detail: z.enum(['auto', 'low', 'high']).optional(),
}).strict();

const ResponsesUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.string(),
    z.array(z.union([
      ResponsesInputTextPartSchema,
      ResponsesInputImagePartSchema,
    ])).min(1),
  ]),
}).strict();

const ResponsesFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().min(1).optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
}).strict();

const ResponsesFunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.string(),
}).strict();

const ResponsesFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
}).strict();

const ResponsesSpecificToolChoiceSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
}).strict();

export const ResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string(),
    z.array(z.union([
      ResponsesTextMessageSchema,
      ResponsesUserMessageSchema,
      ResponsesFunctionCallSchema,
      ResponsesFunctionCallOutputSchema,
    ])).min(1),
  ]),
  previous_response_id: z.string().min(1).optional(),
  store: z.boolean().optional(),
  stream: z.boolean().optional(),
  tools: z.array(ResponsesFunctionToolSchema).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.literal('required'),
    ResponsesSpecificToolChoiceSchema,
  ]).optional(),
}).strict();

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;
