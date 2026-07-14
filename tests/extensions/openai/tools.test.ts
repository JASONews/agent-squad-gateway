import { describe, expect, it } from 'vitest';
import {
  AdapterProtocolError,
  buildToolOutputSchema,
  FunctionCallMetadataStore,
  normalizeChatToolRoundTrip,
  normalizeResponsesToolRoundTrip,
  StructuredEnvelopeDecoder,
  ToolInputError,
} from '../../../src/extensions/openai/tools.js';

const weather = {
  type: 'function',
  function: {
    name: 'weather',
    description: 'Get the weather',
    parameters: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
} as const;

const clock = {
  type: 'function',
  function: {
    name: 'clock',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string' } },
      required: ['timezone'],
    },
  },
} as const;

function decodeOneByteAtATime(
  schema: NonNullable<ReturnType<typeof buildToolOutputSchema>>,
  json: string,
) {
  const decoder = new StructuredEnvelopeDecoder(schema);
  const utf8 = new TextDecoder();
  let streamed = '';
  for (const byte of new TextEncoder().encode(json)) {
    streamed += decoder.push(utf8.decode(Uint8Array.of(byte), { stream: true }));
  }
  streamed += decoder.push(utf8.decode());
  return { streamed, result: decoder.finish() };
}

describe('buildToolOutputSchema', () => {
  it('builds exact discriminator-first auto branches in function order without mutating input', () => {
    const tools = structuredClone([weather, clock]);
    const before = structuredClone(tools);
    const schema = buildToolOutputSchema(tools, 'auto');

    expect(schema).toEqual({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'assistant_text' },
            content: { type: 'string' },
          },
          required: ['type', 'content'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'tool_calls' },
            tool_calls: {
              type: 'array',
              minItems: 1,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Get the weather',
                    properties: {
                      name: { const: 'weather' },
                      arguments: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { city: { type: 'string' } },
                        required: ['city'],
                      },
                    },
                    required: ['name', 'arguments'],
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { const: 'clock' },
                      arguments: {
                        type: 'object',
                        properties: { timezone: { type: 'string' } },
                        required: ['timezone'],
                      },
                    },
                    required: ['name', 'arguments'],
                  },
                ],
              },
            },
          },
          required: ['type', 'tool_calls'],
        },
      ],
    });
    expect(tools).toEqual(before);
  });

  it('implements none, required, and specific choice semantics', () => {
    expect(buildToolOutputSchema([weather], 'none')).toBeNull();
    expect(buildToolOutputSchema([weather, clock], 'required')?.oneOf).toHaveLength(1);
    const specific = buildToolOutputSchema(
      [weather, clock],
      { type: 'function', function: { name: 'clock' } },
    );
    expect(specific?.oneOf).toHaveLength(1);
    expect(JSON.stringify(specific)).toContain('clock');
    expect(JSON.stringify(specific)).not.toContain('weather');
  });

  it('rejects unknown choices, non-function tools, external refs, count, size, and depth limits', () => {
    expect(() => buildToolOutputSchema(
      [weather],
      { type: 'function', function: { name: 'missing' } },
    )).toThrow(ToolInputError);
    expect(() => buildToolOutputSchema([{ type: 'web_search' }], 'auto')).toThrow(ToolInputError);
    expect(() => buildToolOutputSchema([{
      type: 'function',
      function: { name: 'bad', parameters: { type: 'object', $ref: 'https://example.com/schema' } },
    }], 'auto')).toThrow(ToolInputError);
    expect(() => buildToolOutputSchema(Array.from({ length: 65 }, (_, index) => ({
      type: 'function', function: { name: `f${index}`, parameters: { type: 'object' } },
    })), 'auto')).toThrow(ToolInputError);
    expect(() => buildToolOutputSchema([{
      type: 'function',
      function: { name: 'huge', parameters: { type: 'object', description: 'x'.repeat(70 * 1024) } },
    }], 'auto')).toThrow(ToolInputError);

    let nested: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 17; index += 1) nested = { allOf: [nested] };
    expect(() => buildToolOutputSchema([{
      type: 'function', function: { name: 'deep', parameters: nested },
    }], 'auto')).toThrow(ToolInputError);
  });

  it('rebases permitted local refs for the embedded provider schema and validates them at runtime', () => {
    const schema = buildToolOutputSchema([{
      type: 'function',
      function: {
        name: 'local_ref',
        parameters: {
          type: 'object',
          properties: { value: { $ref: '#/$defs/nonempty' } },
          required: ['value'],
          $defs: { nonempty: { type: 'string', minLength: 1 } },
        },
      },
    }], 'required')!;
    expect(JSON.stringify(schema)).toContain(
      '#/oneOf/0/properties/tool_calls/items/oneOf/0/properties/arguments/$defs/nonempty',
    );
    const valid = new StructuredEnvelopeDecoder(schema);
    valid.push('{"type":"tool_calls","tool_calls":[{"name":"local_ref","arguments":{"value":"ok"}}]}');
    expect(valid.finish()).toMatchObject({ type: 'tool_calls' });

    const invalid = new StructuredEnvelopeDecoder(schema);
    invalid.push('{"type":"tool_calls","tool_calls":[{"name":"local_ref","arguments":{"value":""}}]}');
    expect(() => invalid.finish()).toThrow(AdapterProtocolError);
  });

  it('preserves special schema keys as exact own properties and rejects their bypass arguments', () => {
    const parameters = JSON.parse(
      '{"type":"object","properties":{"__proto__":false},"required":["__proto__"]}',
    ) as Record<string, unknown>;
    const schema = buildToolOutputSchema([{
      type: 'function',
      function: { name: 'special_key', parameters },
    }], 'required')!;

    expect(JSON.stringify(schema)).toContain(
      '"properties":{"__proto__":false},"required":["__proto__"]',
    );
    const decoder = new StructuredEnvelopeDecoder(schema);
    decoder.push(
      '{"type":"tool_calls","tool_calls":[{"name":"special_key","arguments":{"__proto__":"bypass"}}]}',
    );
    expect(() => decoder.finish()).toThrow(AdapterProtocolError);
  });
});

describe('StructuredEnvelopeDecoder', () => {
  it('streams assistant text safely across one-byte Unicode and escape fragmentation', () => {
    const schema = buildToolOutputSchema([weather], 'auto')!;
    const content = 'quote: \\" slash: \\\\ line:\n snowman: ☃ rocket: 🚀';
    const json = JSON.stringify({ type: 'assistant_text', content });
    const decoded = decodeOneByteAtATime(schema, json);

    expect(decoded.streamed).toBe(content);
    expect(decoded.result).toEqual({ type: 'assistant_text', content });

    const escapedUnicode = decodeOneByteAtATime(
      schema,
      '{"type":"assistant_text","content":"\\u2603 \\uD83D\\uDE80"}',
    );
    expect(escapedUnicode.streamed).toBe('☃ 🚀');
    expect(escapedUnicode.result).toEqual({ type: 'assistant_text', content: '☃ 🚀' });
  });

  it('buffers and validates tool calls before returning them', () => {
    const schema = buildToolOutputSchema([weather, clock], 'required')!;
    const json = JSON.stringify({
      type: 'tool_calls',
      tool_calls: [
        { name: 'weather', arguments: { city: 'Boston' } },
        { name: 'clock', arguments: { timezone: 'UTC' } },
      ],
    });
    const decoded = decodeOneByteAtATime(schema, json);

    expect(decoded.streamed).toBe('');
    expect(decoded.result).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { name: 'weather', arguments: { city: 'Boston' } },
        { name: 'clock', arguments: { timezone: 'UTC' } },
      ],
    });
  });

  it('rejects content before the discriminator, invalid arguments, malformed JSON, and trailing JSON', () => {
    const schema = buildToolOutputSchema([weather], 'auto')!;
    for (const json of [
      '{"content":"leak","type":"assistant_text"}',
      '{"type":"tool_calls","tool_calls":[{"name":"weather","arguments":{"city":2}}]}',
      '{"type":"assistant_text","content":"unterminated}',
      '{"type":"assistant_text","content":"ok"}{}',
    ]) {
      const decoder = new StructuredEnvelopeDecoder(schema);
      expect(() => {
        decoder.push(json);
        decoder.finish();
      }).toThrow(AdapterProtocolError);
    }
  });
});

describe('client tool result round trips', () => {
  it('preserves a complete Chat call/result sequence as provider input', () => {
    expect(normalizeChatToolRoundTrip([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"Boston"}' } },
          { id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{"timezone":"UTC"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_b', content: '12:00' },
      { role: 'tool', tool_call_id: 'call_a', content: 'Sunny' },
      { role: 'user', content: 'Summarize' },
    ])).toEqual([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_a', name: 'weather', arguments: { city: 'Boston' } },
          { id: 'call_b', name: 'clock', arguments: { timezone: 'UTC' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_b', content: '12:00' },
      { role: 'tool', toolCallId: 'call_a', content: 'Sunny' },
      { role: 'user', content: 'Summarize' },
    ]);
  });

  it('rejects malformed arguments, duplicate IDs/results, unknown results, and partial sets', () => {
    const call = (id: string, args = '{}') => ({
      id, type: 'function', function: { name: 'weather', arguments: args },
    });
    for (const messages of [
      [{ role: 'assistant', tool_calls: [call('call_a', '[]')] }, { role: 'tool', tool_call_id: 'call_a', content: 'x' }],
      [{ role: 'assistant', tool_calls: [call('call_a'), call('call_a')] }],
      [{ role: 'tool', tool_call_id: 'call_unknown', content: 'x' }],
      [{ role: 'assistant', tool_calls: [call('call_a')] }, { role: 'user', content: 'too soon' }],
      [
        { role: 'assistant', tool_calls: [call('call_a')] },
        { role: 'tool', tool_call_id: 'call_a', content: 'x' },
        { role: 'tool', tool_call_id: 'call_a', content: 'x' },
      ],
    ]) expect(() => normalizeChatToolRoundTrip(messages)).toThrow(ToolInputError);
  });

  it('validates Responses continuation results against bounded process-local metadata', () => {
    const metadata = new FunctionCallMetadataStore(2);
    metadata.remember('resp_a', ['call_a', 'call_b']);
    expect(normalizeResponsesToolRoundTrip([
      { type: 'function_call_output', call_id: 'call_b', output: '12:00' },
      { type: 'function_call_output', call_id: 'call_a', output: 'Sunny' },
    ], metadata.expected('resp_a'))).toEqual([
      { role: 'tool', toolCallId: 'call_b', content: '12:00' },
      { role: 'tool', toolCallId: 'call_a', content: 'Sunny' },
    ]);
    expect(() => normalizeResponsesToolRoundTrip([
      { type: 'function_call_output', call_id: 'call_a', output: 'Sunny' },
    ], metadata.expected('resp_a'))).toThrow(ToolInputError);
    expect(() => metadata.expected('resp_missing')).toThrow(ToolInputError);

    metadata.remember('resp_b', ['call_c']);
    metadata.remember('resp_c', ['call_d']);
    expect(() => metadata.expected('resp_a')).toThrow(ToolInputError);
  });

  it('preserves a contiguous Responses call batch and requires one known output per call', () => {
    const calls = [
      { type: 'function_call', call_id: 'call_a', name: 'a', arguments: '{"a":1}' },
      { type: 'function_call', call_id: 'call_b', name: 'b', arguments: '{"b":2}' },
    ];
    expect(normalizeResponsesToolRoundTrip([
      ...calls,
      { type: 'function_call_output', call_id: 'call_a', output: 'A' },
      { type: 'function_call_output', call_id: 'call_b', output: 'B' },
    ])).toEqual([
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_a', name: 'a', arguments: { a: 1 } },
          { id: 'call_b', name: 'b', arguments: { b: 2 } },
        ],
      },
      { role: 'tool', toolCallId: 'call_a', content: 'A' },
      { role: 'tool', toolCallId: 'call_b', content: 'B' },
    ]);

    for (const outputs of [
      [{ type: 'function_call_output', call_id: 'call_a', output: 'A' }],
      [
        { type: 'function_call_output', call_id: 'call_a', output: 'A' },
        { type: 'function_call_output', call_id: 'call_a', output: 'again' },
      ],
      [
        { type: 'function_call_output', call_id: 'call_a', output: 'A' },
        { type: 'function_call_output', call_id: 'call_unknown', output: '?' },
      ],
    ]) {
      expect(() => normalizeResponsesToolRoundTrip([...calls, ...outputs])).toThrow(ToolInputError);
    }
  });
});
