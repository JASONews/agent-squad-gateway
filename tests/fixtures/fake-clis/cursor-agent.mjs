import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CURSOR_SCENARIO ?? 'text';
const recordPath = process.env.FAKE_CURSOR_RECORD;
let stdin = '';
let outputChain = Promise.resolve();

const FIXED_FLAGS = [
  '--print',
  '--output-format',
  '--stream-partial-output',
  '--mode',
  '--resume',
  '--model',
  '--list-models',
  '--sandbox',
  '--trust',
];

function record(value) {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
}

function writeLine(value, fragmented = false) {
  const line = `${JSON.stringify(value)}\n`;
  outputChain = outputChain.then(async () => {
    if (!fragmented) {
      process.stdout.write(line);
      return;
    }
    const split = Math.max(1, Math.floor(line.length / 2));
    process.stdout.write(line.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 2));
    process.stdout.write(line.slice(split));
  });
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sessionId() {
  return option('--resume') ?? 'cursor-session-1';
}

function emitInit() {
  writeLine({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: process.cwd(),
    session_id: sessionId(),
    model: 'Fixture Model',
    permissionMode: 'default',
  }, true);
}

function emitUser() {
  writeLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: stdin }] },
    session_id: sessionId(),
  }, true);
}

function emitPartial(text) {
  writeLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: sessionId(),
    timestamp_ms: Date.now(),
  }, true);
}

function emitThinking(subtype, text) {
  writeLine({
    type: 'thinking',
    subtype,
    ...(text === undefined ? {} : { text }),
    session_id: sessionId(),
    timestamp_ms: Date.now(),
  }, true);
}

function emitAggregate(text) {
  writeLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: sessionId(),
  }, true);
}

function emitResult(text, overrides = {}) {
  writeLine({
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    result: text,
    session_id: sessionId(),
    ...overrides,
  }, true);
}

async function emitTurn() {
  if (scenario === 'protocol-error-before-init') {
    writeLine({ type: 'unexpected_event', detail: 'Sensitive Cursor fixture output' }, true);
    await outputChain;
    return;
  }

  emitInit();
  if (scenario === 'cancel') {
    process.on('SIGINT', () => {
      record({ kind: 'signal', signal: 'SIGINT' });
      process.exit(0);
    });
    setInterval(() => undefined, 1_000);
    return;
  }
  emitUser();

  if (scenario === 'tool-call') {
    writeLine({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'cursor-tool-1',
      tool_call: { readToolCall: { args: { path: 'secret.txt' } } },
      session_id: sessionId(),
    }, true);
    emitResult('Sensitive native tool result');
    await outputChain;
    return;
  }

  if (scenario === 'provider-error') {
    emitResult('Sensitive Cursor provider failure', {
      subtype: 'error_during_execution',
      is_error: true,
    });
    await outputChain;
    return;
  }

  const structured = stdin.includes('Required response schema:');
  const output = structured
    ? '{"type":"assistant_text","content":"Confirmed."}'
    : 'Hello world';

  emitThinking('delta', 'Sensitive native reasoning');
  emitThinking('completed');
  if (scenario !== 'no-partial') {
    const split = structured ? output.indexOf(',') + 1 : 6;
    emitPartial(output.slice(0, split));
    emitPartial(output.slice(split));
  }
  emitAggregate(scenario === 'aggregate-mismatch' ? `${output}!` : output);
  emitResult(output);
  await outputChain;
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('2026.07.09-test000\n');
} else if (args.length === 1 && args[0] === '--help') {
  const flags = scenario === 'help-missing-flag'
    ? FIXED_FLAGS.filter((flag) => flag !== '--sandbox')
    : FIXED_FLAGS;
  process.stdout.write(`Usage: agent [options]\n${flags.join('\n')}\n`);
} else if (args.length === 1 && args[0] === '--list-models') {
  process.stdout.write([
    'Available models',
    '',
    'auto - Auto (default)',
    'gpt-5.6-sol-max - GPT-5.6 Sol 1M Max',
    'claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking',
    '',
    'Tip: use --model <id> to switch.',
    '',
  ].join('\n'));
} else if (scenario === 'nonzero') {
  process.stderr.write('Sensitive Cursor fixture credential\n');
  process.exitCode = 7;
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', async () => {
    record({ kind: 'invocation', args, stdin });
    await emitTurn();
  });
}
