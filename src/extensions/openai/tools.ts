import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import type { ProviderInputItem } from '../../provider-runtime/types.js';

const MAX_FUNCTIONS = 64;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_TOOL_ENVELOPE_BYTES = 1024 * 1024;
const TOOL_METADATA = Symbol('toolMetadata');

type JsonObject = Record<string, unknown>;

export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface DecodedToolCall {
  name: string;
  arguments: JsonObject;
}

export type DecodedEnvelope =
  | { type: 'assistant_text'; content: string }
  | { type: 'tool_calls'; toolCalls: DecodedToolCall[] };

interface FunctionRuntime {
  name: string;
  validate: ValidateFunction;
}

interface ToolMetadata {
  mode: 'auto' | 'required';
  functions: Map<string, FunctionRuntime>;
}

export type ToolOutputSchema = JsonObject & { [TOOL_METADATA]?: ToolMetadata };

export class ToolInputError extends Error {
  constructor(message = 'invalid_tools') {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class AdapterProtocolError extends Error {
  readonly code = 'adapter_protocol_error';

  constructor() {
    super('adapter_protocol_error');
    this.name = 'AdapterProtocolError';
  }
}

function failInput(message?: string): never {
  throw new ToolInputError(message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaObject(): JsonObject {
  return Object.create(null) as JsonObject;
}

function defineSchemaProperty(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sanitizeSchema(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (depth > MAX_SCHEMA_DEPTH) failInput('tool_schema_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failInput('invalid_tool_schema');
    return value;
  }
  if (typeof value !== 'object') failInput('invalid_tool_schema');
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) failInput('invalid_tool_schema');
  }
  if (ancestors.has(value)) failInput('tool_schema_cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeSchema(entry, depth + 1, ancestors));
    }
    const result = schemaObject();
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$schema') continue;
      if (key === '$ref' && (typeof entry !== 'string' || !entry.startsWith('#'))) {
        failInput('external_tool_schema_ref');
      }
      defineSchemaProperty(result, key, sanitizeSchema(entry, depth + 1, ancestors));
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key])}`
  )).join(',')}}`;
}

function parseTools(tools: unknown): Array<{ tool: FunctionTool; parameters: JsonObject }> {
  if (!Array.isArray(tools)) failInput();
  if (tools.length > MAX_FUNCTIONS) failInput('too_many_tools');
  const names = new Set<string>();
  return tools.map((value) => {
    if (!isObject(value) || value.type !== 'function' || !isObject(value.function)) failInput();
    const definition = value.function;
    if (typeof definition.name !== 'string' || definition.name.length === 0) failInput();
    if (names.has(definition.name)) failInput('duplicate_tool_name');
    names.add(definition.name);
    if (definition.description !== undefined && typeof definition.description !== 'string') failInput();
    if (definition.parameters !== undefined && !isObject(definition.parameters)) failInput();
    const parameters = sanitizeSchema(
      definition.parameters ?? { type: 'object', properties: {} },
      1,
      new Set(),
    );
    if (!isObject(parameters)) failInput();
    return {
      tool: {
        type: 'function',
        function: {
          name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          parameters,
        },
      },
      parameters,
    };
  });
}

function parseChoice(choice: unknown): ToolChoice {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (
    isObject(choice)
    && choice.type === 'function'
    && isObject(choice.function)
    && typeof choice.function.name === 'string'
    && Object.keys(choice).length === 2
    && Object.keys(choice.function).length === 1
  ) {
    return { type: 'function', function: { name: choice.function.name } };
  }
  return failInput('invalid_tool_choice');
}

function assistantBranch(): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { const: 'assistant_text' },
      content: { type: 'string' },
    },
    required: ['type', 'content'],
  };
}

function functionBranch(tool: FunctionTool, parameters: JsonObject): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    ...(tool.function.description === undefined
      ? {}
      : { description: tool.function.description }),
    properties: {
      name: { const: tool.function.name },
      arguments: parameters,
    },
    required: ['name', 'arguments'],
  };
}

function rebaseLocalRefs(value: unknown, base: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => rebaseLocalRefs(entry, base));
  if (!isObject(value)) return value;
  const result = schemaObject();
  for (const [key, entry] of Object.entries(value)) {
    defineSchemaProperty(
      result,
      key,
      key === '$ref' && typeof entry === 'string'
        ? `${base}${entry.slice(1)}`
        : rebaseLocalRefs(entry, base),
    );
  }
  return result;
}

function ajvRuntimeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ajvRuntimeSchema);
  if (!isObject(value)) return value;
  const result = schemaObject();
  for (const [key, entry] of Object.entries(value)) {
    defineSchemaProperty(result, key, ajvRuntimeSchema(entry));
  }
  const properties = result.properties;
  if (isObject(properties) && Object.hasOwn(properties, '__proto__')) {
    const patterns = schemaObject();
    defineSchemaProperty(patterns, '^__proto__$', properties.__proto__);
    const guard = schemaObject();
    defineSchemaProperty(guard, 'patternProperties', patterns);
    const allOf = result.allOf;
    if (allOf === undefined) defineSchemaProperty(result, 'allOf', [guard]);
    else if (Array.isArray(allOf)) allOf.push(guard);
  }
  return result;
}

function toolCallsBranch(
  functions: Array<{ tool: FunctionTool; parameters: JsonObject }>,
  rootBranchIndex: number,
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { const: 'tool_calls' },
      tool_calls: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: functions.map(({ tool, parameters }, functionIndex) => {
            const base = `#/oneOf/${rootBranchIndex}/properties/tool_calls/items/oneOf/${functionIndex}/properties/arguments`;
            return functionBranch(tool, rebaseLocalRefs(parameters, base) as JsonObject);
          }),
        },
      },
    },
    required: ['type', 'tool_calls'],
  };
}

export function buildToolOutputSchema(tools: unknown, choice?: unknown): ToolOutputSchema | null {
  const parsedChoice = parseChoice(choice);
  const parsedTools = parseTools(tools);
  if (parsedChoice === 'none') return null;
  if (parsedTools.length === 0) {
    if (parsedChoice === 'auto') return null;
    failInput('tool_choice_requires_tools');
  }

  let allowed = parsedTools;
  let mode: ToolMetadata['mode'] = parsedChoice === 'auto' ? 'auto' : 'required';
  if (typeof parsedChoice === 'object') {
    allowed = parsedTools.filter(({ tool }) => tool.function.name === parsedChoice.function.name);
    if (allowed.length === 0) failInput('unknown_tool_choice');
    mode = 'required';
  }

  const schema: ToolOutputSchema = {
    oneOf: mode === 'auto'
      ? [assistantBranch(), toolCallsBranch(allowed, 1)]
      : [toolCallsBranch(allowed, 0)],
  };
  if (Buffer.byteLength(canonicalJson(schema), 'utf8') > MAX_SCHEMA_BYTES) {
    failInput('tool_schema_too_large');
  }

  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateSchema: true,
    ownProperties: true,
  });
  const functions = new Map<string, FunctionRuntime>();
  try {
    for (const { tool, parameters } of allowed) {
      functions.set(tool.function.name, {
        name: tool.function.name,
        validate: ajv.compile(ajvRuntimeSchema(parameters) as JsonObject),
      });
    }
  } catch {
    failInput('invalid_tool_schema');
  }
  Object.defineProperty(schema, TOOL_METADATA, {
    value: { mode, functions } satisfies ToolMetadata,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return schema;
}

function metadataFor(schema: ToolOutputSchema): ToolMetadata {
  const metadata = schema[TOOL_METADATA];
  if (!metadata) throw new ToolInputError('unprepared_tool_schema');
  return metadata;
}

type PrefixState =
  | 'start'
  | 'first_key_start'
  | 'first_key'
  | 'after_first_key'
  | 'before_type_value'
  | 'type_value'
  | 'after_type_value'
  | 'content_key_start'
  | 'content_key'
  | 'after_content_key'
  | 'before_content_value'
  | 'content_value'
  | 'after_content_value'
  | 'after_object';

function whitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

export class StructuredEnvelopeDecoder {
  private readonly metadata: ToolMetadata;
  private state: PrefixState = 'start';
  private token = '';
  private raw = '';
  private rawBytes = 0;
  private branch: 'assistant_text' | 'tool_calls' | undefined;
  private content = '';
  private escaped = false;
  private unicode: string | undefined;
  private pendingHighSurrogate: number | undefined;
  private finished = false;

  constructor(schema: ToolOutputSchema) {
    this.metadata = metadataFor(schema);
  }

  push(fragment: string): string {
    if (this.finished) throw new AdapterProtocolError();
    let emitted = '';
    for (const char of fragment) {
      if (this.branch === 'tool_calls') this.appendRaw(char);
      else if (this.branch === undefined) this.appendRaw(char);
      emitted += this.consume(char);
    }
    return emitted;
  }

  finish(): DecodedEnvelope {
    if (this.finished) throw new AdapterProtocolError();
    this.finished = true;
    if (this.branch === 'assistant_text') {
      if (this.state !== 'after_object' || this.escaped || this.unicode !== undefined || this.pendingHighSurrogate !== undefined) {
        throw new AdapterProtocolError();
      }
      return { type: 'assistant_text', content: this.content };
    }
    if (this.branch !== 'tool_calls') throw new AdapterProtocolError();

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.raw);
    } catch {
      throw new AdapterProtocolError();
    }
    if (!isObject(parsed) || Object.keys(parsed).length !== 2 || parsed.type !== 'tool_calls') {
      throw new AdapterProtocolError();
    }
    if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) throw new AdapterProtocolError();
    const toolCalls = parsed.tool_calls.map((call): DecodedToolCall => {
      if (!isObject(call) || Object.keys(call).length !== 2) throw new AdapterProtocolError();
      if (typeof call.name !== 'string' || !isObject(call.arguments)) throw new AdapterProtocolError();
      const runtime = this.metadata.functions.get(call.name);
      if (!runtime || !runtime.validate(call.arguments)) throw new AdapterProtocolError();
      return { name: call.name, arguments: call.arguments };
    });
    return { type: 'tool_calls', toolCalls };
  }

  private appendRaw(char: string): void {
    this.raw += char;
    this.rawBytes += Buffer.byteLength(char, 'utf8');
    if (this.rawBytes > MAX_TOOL_ENVELOPE_BYTES) throw new AdapterProtocolError();
  }

  private consume(char: string): string {
    switch (this.state) {
      case 'start':
        if (whitespace(char)) return '';
        if (char !== '{') throw new AdapterProtocolError();
        this.state = 'first_key_start';
        return '';
      case 'first_key_start':
        if (whitespace(char)) return '';
        if (char !== '"') throw new AdapterProtocolError();
        this.token = '';
        this.state = 'first_key';
        return '';
      case 'first_key':
        if (char === '"') {
          if (this.token !== 'type') throw new AdapterProtocolError();
          this.state = 'after_first_key';
        } else {
          if (char === '\\' || char.charCodeAt(0) < 0x20) throw new AdapterProtocolError();
          this.token += char;
        }
        return '';
      case 'after_first_key':
        if (whitespace(char)) return '';
        if (char !== ':') throw new AdapterProtocolError();
        this.state = 'before_type_value';
        return '';
      case 'before_type_value':
        if (whitespace(char)) return '';
        if (char !== '"') throw new AdapterProtocolError();
        this.token = '';
        this.state = 'type_value';
        return '';
      case 'type_value':
        if (char === '"') {
          if (this.token !== 'assistant_text' && this.token !== 'tool_calls') throw new AdapterProtocolError();
          if (this.token === 'assistant_text' && this.metadata.mode !== 'auto') throw new AdapterProtocolError();
          this.branch = this.token;
          this.state = 'after_type_value';
        } else {
          if (char === '\\' || char.charCodeAt(0) < 0x20) throw new AdapterProtocolError();
          this.token += char;
        }
        return '';
      case 'after_type_value':
        if (this.branch === 'tool_calls') return '';
        if (whitespace(char)) return '';
        if (char !== ',') throw new AdapterProtocolError();
        this.state = 'content_key_start';
        return '';
      case 'content_key_start':
        if (whitespace(char)) return '';
        if (char !== '"') throw new AdapterProtocolError();
        this.token = '';
        this.state = 'content_key';
        return '';
      case 'content_key':
        if (char === '"') {
          if (this.token !== 'content') throw new AdapterProtocolError();
          this.state = 'after_content_key';
        } else {
          if (char === '\\' || char.charCodeAt(0) < 0x20) throw new AdapterProtocolError();
          this.token += char;
        }
        return '';
      case 'after_content_key':
        if (whitespace(char)) return '';
        if (char !== ':') throw new AdapterProtocolError();
        this.state = 'before_content_value';
        return '';
      case 'before_content_value':
        if (whitespace(char)) return '';
        if (char !== '"') throw new AdapterProtocolError();
        this.state = 'content_value';
        return '';
      case 'content_value':
        return this.consumeContent(char);
      case 'after_content_value':
        if (whitespace(char)) return '';
        if (char !== '}') throw new AdapterProtocolError();
        this.state = 'after_object';
        return '';
      case 'after_object':
        if (!whitespace(char)) throw new AdapterProtocolError();
        return '';
    }
  }

  private consumeContent(char: string): string {
    if (this.unicode !== undefined) {
      if (!this.isHex(char)) throw new AdapterProtocolError();
      this.unicode += char;
      if (this.unicode.length < 4) return '';
      const code = Number.parseInt(this.unicode, 16);
      this.unicode = undefined;
      this.escaped = false;
      return this.emitCodeUnit(code);
    }
    if (this.escaped) {
      if (char === 'u') {
        this.unicode = '';
        return '';
      }
      this.escaped = false;
      const escaped: Record<string, string> = {
        '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
      };
      const decoded = escaped[char];
      if (decoded === undefined) throw new AdapterProtocolError();
      return this.emitText(decoded);
    }
    if (char === '\\') {
      this.escaped = true;
      return '';
    }
    if (char === '"') {
      if (this.pendingHighSurrogate !== undefined) throw new AdapterProtocolError();
      this.state = 'after_content_value';
      return '';
    }
    if (char.charCodeAt(0) < 0x20) throw new AdapterProtocolError();
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdfff) return this.emitCodeUnit(code);
    }
    return this.emitText(char);
  }

  private emitCodeUnit(code: number): string {
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.pendingHighSurrogate !== undefined) throw new AdapterProtocolError();
      this.pendingHighSurrogate = code;
      return '';
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (this.pendingHighSurrogate === undefined) throw new AdapterProtocolError();
      const text = String.fromCharCode(this.pendingHighSurrogate, code);
      this.pendingHighSurrogate = undefined;
      return this.emitText(text);
    }
    if (this.pendingHighSurrogate !== undefined) throw new AdapterProtocolError();
    return this.emitText(String.fromCharCode(code));
  }

  private isHex(char: string): boolean {
    const code = char.charCodeAt(0);
    return (code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x46)
      || (code >= 0x61 && code <= 0x66);
  }

  private emitText(text: string): string {
    if (this.pendingHighSurrogate !== undefined) throw new AdapterProtocolError();
    this.content += text;
    return text;
  }
}

export function assignGatewayCallIds(calls: DecodedToolCall[]): Array<DecodedToolCall & { id: string }> {
  return calls.map((call) => ({ ...call, id: `call_${randomUUID()}` }));
}

export function normalizeChatToolRoundTrip(messages: unknown): ProviderInputItem[] {
  if (!Array.isArray(messages)) failInput('invalid_messages');
  const input: ProviderInputItem[] = [];
  const seenCallIds = new Set<string>();
  let pending = new Set<string>();
  let seenResults = new Set<string>();

  for (const message of messages) {
    if (!isObject(message) || typeof message.role !== 'string') failInput('invalid_message');
    if (message.role === 'tool') {
      if (
        typeof message.tool_call_id !== 'string'
        || typeof message.content !== 'string'
        || !pending.has(message.tool_call_id)
        || seenResults.has(message.tool_call_id)
      ) failInput('invalid_tool_result');
      seenResults.add(message.tool_call_id);
      input.push({ role: 'tool', toolCallId: message.tool_call_id, content: message.content });
      continue;
    }
    if (pending.size !== seenResults.size) failInput('incomplete_tool_results');
    pending = new Set();
    seenResults = new Set();

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.tool_calls.length === 0 || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')) {
        failInput('invalid_tool_calls');
      }
      const toolCalls = message.tool_calls.map((call) => {
        if (!isObject(call) || call.type !== 'function' || !isObject(call.function)) failInput('invalid_tool_call');
        if (typeof call.id !== 'string' || seenCallIds.has(call.id)) failInput('duplicate_tool_call_id');
        if (typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') failInput('invalid_tool_call');
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          failInput('invalid_tool_arguments');
        }
        if (!isObject(args)) failInput('invalid_tool_arguments');
        seenCallIds.add(call.id);
        pending.add(call.id);
        return { id: call.id, name: call.function.name, arguments: args };
      });
      input.push({ role: 'assistant', content: message.content ?? null, toolCalls });
      continue;
    }
    if (
      (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')
      || typeof message.content !== 'string'
    ) failInput('invalid_message');
    input.push({ role: message.role, content: message.content });
  }
  if (pending.size !== seenResults.size) failInput('incomplete_tool_results');
  return input;
}

export class FunctionCallMetadataStore {
  private readonly entries = new Map<string, ReadonlySet<string>>();

  constructor(private readonly capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('invalid_metadata_capacity');
  }

  remember(responseId: string, callIds: string[]): void {
    if (responseId.length === 0) failInput('invalid_call_metadata');
    const ids = new Set(callIds);
    if (ids.size !== callIds.length || [...ids].some((id) => id.length === 0)) {
      failInput('invalid_call_metadata');
    }
    this.entries.delete(responseId);
    this.entries.set(responseId, ids);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  expected(responseId: string): ReadonlySet<string> {
    const ids = this.entries.get(responseId);
    if (!ids) failInput('tool_validation_state_unavailable');
    return new Set(ids);
  }

  find(responseId: string): ReadonlySet<string> | undefined {
    const ids = this.entries.get(responseId);
    return ids === undefined ? undefined : new Set(ids);
  }
}

function parseArgumentObject(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failInput('invalid_tool_arguments');
  }
  if (!isObject(parsed)) failInput('invalid_tool_arguments');
  return parsed;
}

export function normalizeResponsesToolRoundTrip(
  items: unknown,
  expectedResults?: ReadonlySet<string>,
): ProviderInputItem[] {
  if (!Array.isArray(items) || items.length === 0) failInput('invalid_response_input');
  const input: ProviderInputItem[] = [];

  if (expectedResults !== undefined) {
    const received = new Set<string>();
    for (const item of items) {
      if (
        !isObject(item)
        || item.type !== 'function_call_output'
        || typeof item.call_id !== 'string'
        || typeof item.output !== 'string'
        || !expectedResults.has(item.call_id)
        || received.has(item.call_id)
      ) failInput('invalid_function_call_output');
      received.add(item.call_id);
      input.push({ role: 'tool', toolCallId: item.call_id, content: item.output });
    }
    if (received.size !== expectedResults.size) failInput('incomplete_tool_results');
    return input;
  }

  const seenCallIds = new Set<string>();
  let pending = new Set<string>();
  let results = new Set<string>();
  let activeCalls: Array<{ id: string; name: string; arguments: JsonObject }> | undefined;
  for (const item of items) {
    if (!isObject(item)) failInput('invalid_response_input');
    if (item.type === 'function_call') {
      if (!activeCalls) {
        if (pending.size !== results.size) failInput('incomplete_tool_results');
        if (results.size > 0) {
          pending = new Set();
          results = new Set();
        }
        activeCalls = [];
        input.push({ role: 'assistant', content: null, toolCalls: activeCalls });
      }
      if (
        typeof item.call_id !== 'string'
        || typeof item.name !== 'string'
        || typeof item.arguments !== 'string'
        || seenCallIds.has(item.call_id)
      ) failInput('invalid_function_call');
      const call = {
        id: item.call_id,
        name: item.name,
        arguments: parseArgumentObject(item.arguments),
      };
      seenCallIds.add(item.call_id);
      pending.add(item.call_id);
      activeCalls.push(call);
      continue;
    }
    activeCalls = undefined;
    if (item.type === 'function_call_output') {
      if (
        typeof item.call_id !== 'string'
        || typeof item.output !== 'string'
        || !pending.has(item.call_id)
        || results.has(item.call_id)
      ) failInput('invalid_function_call_output');
      results.add(item.call_id);
      input.push({ role: 'tool', toolCallId: item.call_id, content: item.output });
      continue;
    }
    if (pending.size !== results.size) failInput('incomplete_tool_results');
    pending = new Set();
    results = new Set();
    if (
      (item.role !== 'system' && item.role !== 'user' && item.role !== 'assistant')
      || typeof item.content !== 'string'
    ) failInput('invalid_response_input');
    input.push({ role: item.role, content: item.content });
  }
  if (pending.size !== results.size) failInput('incomplete_tool_results');
  return input;
}
