import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'text';
const recordPath = process.env.FAKE_CLAUDE_RECORD;
let stdin = '';
let outputChain = Promise.resolve();

const FIXED_FLAGS = [
  '--print',
  '--safe-mode',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--mcp-config',
  '--tools',
  '--permission-mode',
  '--no-chrome',
  '--system-prompt',
  '--model',
  '--effort',
  '--output-format',
  '--include-partial-messages',
  '--verbose',
  '--input-format',
  '--no-session-persistence',
  '--resume',
  '--json-schema',
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
    const first = Math.max(1, Math.floor(line.length / 3));
    const second = Math.max(first + 1, Math.floor(line.length * 2 / 3));
    process.stdout.write(line.slice(0, first));
    await new Promise((resolve) => setTimeout(resolve, 2));
    process.stdout.write(line.slice(first, second));
    await new Promise((resolve) => setTimeout(resolve, 2));
    process.stdout.write(line.slice(second));
  });
}

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sessionId() {
  return option('--resume') ?? 'claude-session-1';
}

function emitInit() {
  writeLine({
    type: 'system',
    subtype: 'init',
    session_id: sessionId(),
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    agents: [],
    plugins: [],
    permissionMode: 'dontAsk',
  }, true);
}

function emitTextDelta(text) {
  writeLine({
    type: 'stream_event',
    session_id: sessionId(),
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  }, true);
}

function emitResult(overrides = {}) {
  writeLine({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId(),
    result: 'Hello world',
    ...overrides,
  }, true);
}

async function emitTurn() {
  if (scenario === 'protocol-error-before-init') {
    writeLine({
      type: 'unexpected_event',
      detail: 'Sensitive Claude pre-init fixture output',
    }, true);
    await outputChain;
    return;
  }

  if (scenario === 'cancel-tree') {
    const child = spawn(process.execPath, [
      '-e',
      `process.on('SIGINT',()=>{require('node:fs').appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({kind:'signal',target:'child',signal:'SIGINT'})+'\\n');process.exit(0)});process.send('ready');setInterval(()=>{},1000)`,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
    child.unref();
    child.once('message', () => emitInit());
    process.on('SIGINT', () => {
      record({ kind: 'signal', target: 'parent', signal: 'SIGINT' });
      setTimeout(() => process.exit(0), 25);
    });
    return;
  }

  emitInit();

  if (scenario.startsWith('unsafe-block:')) {
    const type = scenario.slice('unsafe-block:'.length);
    writeLine({
      type: 'stream_event',
      session_id: sessionId(),
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type, name: 'unsafe_fixture_block' },
      },
    }, true);
    emitResult();
    await outputChain;
    return;
  }

  if (scenario === 'provider-error') {
    emitResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Sensitive Claude fixture failure details',
    });
    await outputChain;
    return;
  }

  if (scenario === 'schema-result' || args.includes('--json-schema')) {
    const structured = { type: 'assistant_text', content: 'Confirmed.' };
    if (scenario === 'schema-stream') {
      emitTextDelta('{"type":"assistant_text",');
      emitTextDelta('"content":"Confirmed."}');
    }
    writeLine({
      type: 'assistant',
      session_id: sessionId(),
      message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(structured) }] },
    }, true);
    emitResult({ result: JSON.stringify(structured), structured_output: structured });
    await outputChain;
    return;
  }

  emitTextDelta('Hello ');
  emitTextDelta('world');
  writeLine({
    type: 'assistant',
    session_id: sessionId(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
  }, true);
  emitResult();
  await outputChain;
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('Claude Code 9.9.9-test\n');
} else if (args.length === 1 && args[0] === '--help') {
  const flags = scenario === 'help-missing-flag'
    ? FIXED_FLAGS.filter((flag) => flag !== '--no-chrome')
    : FIXED_FLAGS;
  process.stdout.write(`Usage: claude [options]\n${flags.join('\n')}\n`);
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', async () => {
    record({ kind: 'invocation', args, stdin });
    await emitTurn();
  });
}
