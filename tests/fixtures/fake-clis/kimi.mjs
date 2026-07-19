#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.env.FAKE_KIMI_SCENARIO ?? 'text';
const recordPath = process.env.FAKE_KIMI_RECORD;

function record(value) {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
}

record({ kind: 'invocation', args: process.argv.slice(2), cwd: process.cwd() });

if (process.argv.includes('--version')) {
  if (scenario === 'probe-hang') await new Promise(() => {});
  else {
    process.stdout.write('Kimi Code 0.24.1\n');
    process.exit(0);
  }
}

if (process.argv.includes('--help')) {
  if (scenario === 'probe-hang') await new Promise(() => {});
  else {
    process.stdout.write('Usage: kimi [options] [command]\nCommands:\n  login\n  acp\n');
    process.exit(0);
  }
}

if (process.argv[2] !== 'acp') process.exit(2);

let pendingPromptId = null;
let activeSessionId = null;
let model = 'kimi-k2.5';
let thinking = 'off';

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'kimi-k2.5', name: 'Kimi K2.5' },
        { value: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
      ],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: thinking,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  ];
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function update(value) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: activeSessionId, update: value },
  });
}

async function emitText(id, text) {
  if (scenario === 'single-chunk') {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    result(id, { stopReason: 'end_turn' });
    return;
  }
  const split = Math.max(1, Math.floor(text.length / 2));
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: text.slice(0, split) },
  });
  await new Promise((resolve) => setTimeout(resolve, 8));
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: text.slice(split) },
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  result(id, { stopReason: 'end_turn' });
}

function promptText(params) {
  return params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(3);
  }
  record({ kind: 'message', message });

  if (!message.method && message.id === 'permission-1') {
    if (pendingPromptId !== null) {
      const promptId = pendingPromptId;
      pendingPromptId = null;
      void emitText(promptId, 'Permission rejected safely.');
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: message.params.protocolVersion,
        agentCapabilities: {
          promptCapabilities: { image: scenario !== 'no-image-capability' },
          sessionCapabilities: { resume: {} },
        },
        agentInfo: { name: 'kimi-code', version: '0.24.1' },
      });
      break;
    case 'session/new':
      activeSessionId = 'kimi-session-1';
      result(message.id, { sessionId: activeSessionId, configOptions: configOptions() });
      break;
    case 'session/resume':
      activeSessionId = message.params.sessionId;
      result(message.id, { configOptions: configOptions() });
      break;
    case 'session/set_config_option':
      if (message.params.configId === 'model') model = message.params.value;
      if (message.params.configId === 'thinking') thinking = message.params.value;
      result(message.id, { configOptions: configOptions() });
      break;
    case 'session/prompt': {
      const text = promptText(message.params);
      if (scenario === 'permission') {
        pendingPromptId = message.id;
        send({
          jsonrpc: '2.0',
          id: 'permission-1',
          method: 'session/request_permission',
          params: {
            sessionId: activeSessionId,
            toolCall: { toolCallId: 'tool-1', title: 'Run shell command' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_always' },
            ],
          },
        });
      } else if (scenario === 'tool' || scenario === 'tool-update') {
        pendingPromptId = message.id;
        update(scenario === 'tool'
          ? {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'Run shell command',
              kind: 'execute',
              status: 'pending',
            }
          : {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'in_progress',
            });
      } else if (scenario === 'cancel') {
        pendingPromptId = message.id;
      } else if (scenario === 'crash') {
        process.stderr.write(`Sensitive Kimi diagnostic ${'x'.repeat(10 * 1024)}\n`);
        setImmediate(() => process.exit(7));
      } else if (['refusal', 'max_tokens', 'max_turn_requests'].includes(scenario)) {
        result(message.id, { stopReason: scenario });
      } else {
        const output = text.includes('JSON Schema:')
          ? '{"type":"assistant_text","content":"Confirmed."}'
          : 'Hello from Kimi';
        void emitText(message.id, output);
      }
      break;
    }
    case 'session/cancel':
      if (pendingPromptId !== null) {
        result(pendingPromptId, { stopReason: 'cancelled' });
        pendingPromptId = null;
      }
      break;
    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
  }
});

process.on('SIGINT', () => {
  record({ kind: 'signal', signal: 'SIGINT' });
  process.exit(130);
});
