import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'structured';
const recordPath = process.env.FAKE_CODEX_RECORD;
let pending = '';
let phase = 'new';
let threadSequence = 0;
let turnSequence = 0;
let experimentalApiEnabled = false;
const activeTurns = new Map();
const readyThreadIds = new Set();
const concurrentTurns = [];
let outputChain = Promise.resolve();

function record(message) {
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
}

function write(message, fragmented = false) {
  const line = `${JSON.stringify(message)}\n`;
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

function response(id, result) {
  write({ id, result });
}

function notification(method, params, fragmented = false) {
  write({ method, params }, fragmented);
}

function writeBatch(messages) {
  const batch = messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  outputChain = outputChain.then(() => {
    process.stdout.write(batch);
  });
}

function writeBatchAfterExit(messages) {
  const batch = messages.map((message) => `${JSON.stringify(message)}\n`).join('');
  outputChain = outputChain.then(() => {
    const writer = spawn(process.execPath, [
      '-e',
      `setTimeout(() => process.stdout.write(${JSON.stringify(batch)}), 25)`,
    ], { stdio: ['ignore', 'inherit', 'ignore'] });
    writer.unref();
    process.exit(0);
  });
}

function failProtocol(id) {
  write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'fixture_protocol_error' } });
}

function requireInitialized(id) {
  if (phase === 'ready') return true;
  failProtocol(id);
  return false;
}

function emitTurn(threadId, turnId) {
  if (scenario === 'wait-for-interrupt' || scenario === 'ignore-interrupt'
    || scenario === 'unanswered-interrupt') return;
  if (scenario === 'exit-after-turn-start') {
    setTimeout(() => process.exit(17), 5);
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('{malformed json}\n');
    return;
  }
  if (scenario.startsWith('server-request:')) {
    write({
      jsonrpc: '2.0',
      id: 900,
      method: scenario.slice('server-request:'.length),
      params: { unsafe: true },
    });
    return;
  }
  if (scenario.startsWith('unsafe-item:')) {
    notification('item/started', {
      threadId,
      turnId,
      item: { type: scenario.slice('unsafe-item:'.length) },
    });
    return;
  }
  if (scenario === 'failed') {
    notification('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'failed', error: { message: 'provider secret' } },
    }, true);
    return;
  }
  if (scenario === 'interrupted') {
    notification('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'interrupted', error: null },
    }, true);
    return;
  }

  if (scenario === 'concurrent') {
    concurrentTurns.push({ threadId, turnId });
    if (concurrentTurns.length === 2) {
      const [first, second] = concurrentTurns;
      writeBatch([
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: second.threadId, turnId: second.turnId, itemId: 'item_2', delta: `${second.threadId}:a`,
        } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: first.threadId, turnId: first.turnId, itemId: 'item_1', delta: `${first.threadId}:a`,
        } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: second.threadId, turnId: second.turnId, itemId: 'item_2', delta: `${second.threadId}:b`,
        } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: first.threadId, turnId: first.turnId, itemId: 'item_1', delta: `${first.threadId}:b`,
        } },
        { jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: second.threadId, turn: { id: second.turnId, status: 'completed', error: null },
        } },
        { jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: first.threadId, turn: { id: first.turnId, status: 'completed', error: null },
        } },
      ]);
    }
    return;
  }

  if (scenario === 'modern-notifications') {
    notification('mcpServer/startupStatus/updated', { server: 'fixture', status: 'ready' });
    notification('thread/status/changed', { threadId, status: { type: 'active' } });
    notification('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    notification('warning', { message: 'fixture warning' });
    notification('hook/started', { threadId, turnId, hook: { id: 'hook_1' } });
    notification('hook/completed', { threadId, turnId, hook: { id: 'hook_1' } });
    notification('item/started', {
      threadId,
      turnId,
      item: { id: 'user_1', type: 'userMessage' },
    });
    notification('item/completed', {
      threadId,
      turnId,
      item: { id: 'user_1', type: 'userMessage' },
    });
  }

  notification('item/started', {
    threadId,
    turnId,
    item: { type: 'reasoning' },
  });
  if (scenario === 'modern-notifications') {
    notification('item/reasoning/summaryPartAdded', {
      threadId, turnId, itemId: 'reasoning_1', summaryIndex: 0,
    });
    notification('item/reasoning/summaryTextDelta', {
      threadId, turnId, itemId: 'reasoning_1', summaryIndex: 0, delta: 'summary',
    });
    notification('item/completed', {
      threadId,
      turnId,
      item: { id: 'reasoning_1', type: 'reasoning' },
    });
    notification('item/started', {
      threadId,
      turnId,
      item: { id: 'item_1', type: 'agentMessage' },
    });
  }
  const deltas = scenario === 'text'
    ? ['plain ', 'text']
    : scenario === 'invalid-structured-json'
      ? ['not-json']
      : scenario === 'invalid-structured-schema'
        ? ['{"type":"assistant_text","content":"ok","extra":true}']
        : ['{"type":"assistant_text",', '"content":"ok"}'];
  deltas.forEach((delta, index) => {
    setTimeout(() => notification('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'item_1',
      delta,
    }, true), index * 8);
  });
  if (scenario === 'modern-notifications') {
    setTimeout(() => {
      notification('item/completed', {
        threadId,
        turnId,
        item: { id: 'item_1', type: 'agentMessage' },
      });
      notification('thread/tokenUsage/updated', { threadId, tokenUsage: { total: 1 } });
      notification('account/rateLimits/updated', { rateLimits: {} });
      notification('thread/status/changed', { threadId, status: { type: 'idle' } });
    }, deltas.length * 8 + 4);
  }
  setTimeout(() => notification('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', error: null },
  }, true), deltas.length * 8 + 8);
}

function handle(message) {
  record(message);
  const { id, method, params } = message;

  if (method === 'initialize') {
    if (phase !== 'new') return failProtocol(id);
    experimentalApiEnabled = params?.capabilities?.experimentalApi === true;
    phase = 'initialized-response';
    response(id, { userAgent: 'fake-codex-app-server' });
    notification('remoteControl/status/changed', {
      status: 'disabled',
      serverName: 'fake-codex',
    });
    return;
  }
  if (method === 'initialized' && id === undefined && phase === 'initialized-response') {
    phase = 'ready';
    return;
  }
  if (!requireInitialized(id)) return;

  if (method === 'model/list') {
    response(id, {
      data: [
        {
          id: 'gpt-5.6',
          displayName: 'GPT-5.6',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
            { reasoningEffort: 'max', description: 'Maximum' },
          ],
        },
        { id: 'gpt-5.6-mini', displayName: 'GPT-5.6 Mini', supportedReasoningEfforts: null },
      ],
    });
    return;
  }

  if (method === 'thread/start') {
    if (Array.isArray(params.runtimeWorkspaceRoots) && !experimentalApiEnabled) return failProtocol(id);
    threadSequence += 1;
    const threadId = `thread_${threadSequence}`;
    readyThreadIds.add(threadId);
    if (scenario === 'modern-notifications') {
      notification('thread/started', { thread: { id: threadId } });
    }
    response(id, { thread: { id: threadId } });
    return;
  }

  if (method === 'thread/resume') {
    if (Array.isArray(params.runtimeWorkspaceRoots) && !experimentalApiEnabled) return failProtocol(id);
    readyThreadIds.add(params.threadId);
    response(id, { thread: { id: params.threadId } });
    if (scenario === 'modern-notifications') {
      notification('thread/goal/cleared', { threadId: params.threadId });
    }
    return;
  }

  if (method === 'turn/start') {
    if (!readyThreadIds.delete(params.threadId)) return failProtocol(id);
    turnSequence += 1;
    const turnId = `turn_${turnSequence}`;
    activeTurns.set(turnId, { threadId: params.threadId, turnId });
    if (scenario === 'write-then-exit') {
      writeBatchAfterExit([
        { jsonrpc: '2.0', id, result: { turn: { id: turnId } } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: params.threadId, turnId, itemId: 'item_1', delta: '{"type":"assistant_text",',
        } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: params.threadId, turnId, itemId: 'item_1', delta: '"content":"ok"}',
        } },
        { jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: turnId, status: 'completed', error: null },
        } },
      ]);
      return;
    }
    if (scenario === 'out-of-order-responses') {
      setTimeout(() => response(id, { turn: { id: turnId } }), 18);
    } else {
      response(id, { turn: { id: turnId } });
    }
    emitTurn(params.threadId, turnId);
    return;
  }

  if (method === 'turn/interrupt') {
    if (scenario === 'unanswered-interrupt') return;
    response(id, {});
    const active = activeTurns.get(params.turnId);
    if (scenario !== 'ignore-interrupt' && active && active.threadId === params.threadId) {
      notification('turn/completed', {
        threadId: active.threadId,
        turn: { id: active.turnId, status: 'interrupted', error: null },
      }, true);
    }
    return;
  }

  if (method === 'test/echo') {
    setTimeout(() => response(id, { value: params.value }), params.delayMs);
    return;
  }

  failProtocol(id);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let newline = pending.indexOf('\n');
  while (newline !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
    newline = pending.indexOf('\n');
  }
});
