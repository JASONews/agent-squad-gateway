import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_AGY_SCENARIO ?? 'text';
const recordPath = process.env.FAKE_AGY_RECORD;
const home = process.env.FAKE_AGY_HOME;
const conversationId = process.env.FAKE_AGY_CONVERSATION
  ?? '11111111-2222-4333-8444-555555555555';

function record(value) {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
}

function writeConversation() {
  if (!home || scenario === 'missing-conversation') return;
  const cacheDirectory = join(home, '.gemini', 'antigravity-cli', 'cache');
  mkdirSync(cacheDirectory, { recursive: true });
  const cachePath = join(cacheDirectory, 'last_conversations.json');
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    // The fixture starts with an empty cache when no valid one exists.
  }
  cache[realpathSync(process.cwd())] = conversationId;
  writeFileSync(cachePath, JSON.stringify(cache));
}

if (args.length === 1 && args[0] === '--version') {
  record({ kind: 'probe', args });
  process.stdout.write('Antigravity CLI 1.1.1\n');
} else if (args.length === 1 && args[0] === '--help') {
  record({ kind: 'probe', args });
  process.stderr.write([
    'Usage: agy [options]',
    '--sandbox',
    '--model',
    '--print-timeout',
    '--conversation',
    '--print',
    '',
  ].join('\n'));
} else if (args.length === 1 && args[0] === 'models') {
  record({ kind: 'probe', args });
  process.stdin.resume();
  process.stdin.once('end', () => {
    process.stdout.write([
      'Available models:',
      '- Gemini 3.5 Flash (High)',
      '- Claude Sonnet 4.6 (Thinking)',
      '',
    ].join('\n'));
  });
} else {
  record({ kind: 'invocation', args });

  if (scenario === 'nonzero') {
    process.stderr.write('Sensitive Antigravity fixture credential: secret-token\n');
    process.exitCode = 7;
  } else if (scenario === 'oversized') {
    process.stdout.write('x'.repeat((1024 * 1024) + 1));
  } else if (scenario === 'cancel') {
    process.on('SIGINT', () => {
      record({ kind: 'signal', signal: 'SIGINT' });
      process.exit(130);
    });
    setInterval(() => undefined, 1_000);
  } else {
    if (!args.includes('--conversation')) writeConversation();
    const prompt = args.at(-1) ?? '';
    process.stdout.write(prompt.includes('Required response schema:')
      ? '{"type":"assistant_text","content":"final answer"}\n'
      : 'final answer\n');
  }
}
