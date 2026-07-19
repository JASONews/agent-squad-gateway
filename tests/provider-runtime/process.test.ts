import { once } from 'node:events';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  API_PROVIDER_SYSTEM_INSTRUCTION,
  renderProviderInput,
} from '../../src/provider-runtime/provider-input.js';
import { readBoundedLines } from '../../src/provider-runtime/process/line-reader.js';
import { spawnManagedProcess } from '../../src/provider-runtime/process/managed-process.js';

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = [];
  for await (const line of lines) collected.push(line);
  return collected;
}

describe('provider input', () => {
  it('renders roles and tool results without accepting instructions from argv', () => {
    expect(renderProviderInput([
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'Call weather.' },
      { role: 'assistant', content: null, toolCalls: [
        { id: 'call_1', name: 'weather', arguments: { city: 'Paris' } },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: '{"temp":20}' },
    ])).toBe([
      '<system>Answer briefly.</system>',
      '<user>Call weather.</user>',
      '<assistant_tool_calls>[{"id":"call_1","name":"weather","arguments":{"city":"Paris"}}]</assistant_tool_calls>',
      '<tool_result call_id="call_1">{"temp":20}</tool_result>',
    ].join('\n\n'));
  });

  it('escapes role content and tool result identifiers and canonicalizes argument objects', () => {
    expect(renderProviderInput([
      { role: 'assistant', content: '<done>& ready', toolCalls: [
        { id: 'call_"<&', name: 'lookup', arguments: { z: 1, a: { y: 2, x: 3 }, Z: 0 } },
      ] },
      { role: 'tool', toolCallId: 'call_"<&', content: '<unsafe>& result' },
    ])).toBe([
      '<assistant>&lt;done&gt;&amp; ready</assistant>',
      '<assistant_tool_calls>[{"id":"call_\\\"&lt;&amp;","name":"lookup","arguments":{"Z":0,"a":{"x":3,"y":2},"z":1}}]</assistant_tool_calls>',
      '<tool_result call_id="call_&quot;&lt;&amp;">&lt;unsafe&gt;&amp; result</tool_result>',
    ].join('\n\n'));
  });

  it('rejects incomplete tool round trips', () => {
    expect(() => renderProviderInput([
      { role: 'assistant', content: null, toolCalls: [] },
    ])).toThrow(expect.objectContaining({ code: 'adapter_protocol_error' }));
    expect(() => renderProviderInput([
      { role: 'tool', toolCallId: '', content: 'result' },
    ])).toThrow(expect.objectContaining({ code: 'adapter_protocol_error' }));
  });

  it('exports the exact provider safety instruction', () => {
    expect(API_PROVIDER_SYSTEM_INSTRUCTION).toBe([
      'You are responding through Agent Squad Gateway as an API model provider.',
      'Do not use native tools, shell commands, files, browsers, MCP servers, skills, plugins, hooks, agents, or external integrations.',
      'Use only the supplied conversation and return only the requested assistant text or schema-constrained JSON.',
    ].join(' '));
  });
});

describe('bounded line reader', () => {
  it('decodes split UTF-8, CRLF, and a final unterminated line', async () => {
    const encoded = Buffer.from('café\r\nsecond\nfinal');
    const stream = Readable.from([
      encoded.subarray(0, 4),
      encoded.subarray(4, 6),
      encoded.subarray(6, 10),
      encoded.subarray(10),
    ]);

    await expect(collect(readBoundedLines(stream, 128))).resolves.toEqual([
      'café',
      'second',
      'final',
    ]);
  });

  it('rejects a line larger than one MiB', async () => {
    const stream = Readable.from([Buffer.alloc(1_048_577, 120), Buffer.from('\n')]);
    await expect(collect(readBoundedLines(stream, 1_048_576)))
      .rejects.toMatchObject({ code: 'adapter_protocol_error' });
  });

  it('allows an exact byte-limit line followed by split CRLF', async () => {
    const stream = Readable.from([Buffer.from('1234\r'), Buffer.from('\n')]);
    await expect(collect(readBoundedLines(stream, 4))).resolves.toEqual(['1234']);
  });
});

describe('managed process', () => {
  it('retains only an 8 KiB sanitized stderr diagnostic tail', async () => {
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: ['-e', "process.stderr.write('\\u001b[31msecret\\u0000\\u001b[0m' + 'x'.repeat(9000))"],
      cwd: process.cwd(),
    });

    await managed.exited;
    const diagnostic = managed.stderrDiagnostic();
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(diagnostic).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\u001b\[/);
    expect(diagnostic.endsWith('x'.repeat(128))).toBe(true);
  });

  it('sends SIGINT before escalating to SIGTERM', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'asq-managed-process-'));
    const signalsPath = join(dir, 'signals.txt');
    const script = [
      "const fs = require('node:fs')",
      'const path = process.argv[1]',
      "process.on('SIGINT', () => fs.appendFileSync(path, 'SIGINT\\n'))",
      "process.on('SIGTERM', () => { fs.appendFileSync(path, 'SIGTERM\\n'); process.exit(0) })",
      "process.stdout.write('ready\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: ['-e', script, signalsPath],
      cwd: dir,
    });

    try {
      await once(managed.stdout, 'data');
      await managed.interrupt(25);
      expect(readFileSync(signalsPath, 'utf8')).toBe('SIGINT\nSIGTERM\n');
    } finally {
      await managed.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes only a normalized spawn error code', async () => {
    const managed = spawnManagedProcess({
      command: join(process.cwd(), 'definitely-not-a-command'),
      args: [],
      cwd: process.cwd(),
    });

    await expect(managed.exited).rejects.toMatchObject({
      code: 'adapter_spawn_failed',
      message: 'adapter_spawn_failed',
    });
  });

  it('cleans up descendants after the process-group leader has exited', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'asq-managed-descendant-'));
    const pidPath = join(dir, 'descendant.pid');
    const script = [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      'const path = process.argv[1]',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'fs.writeFileSync(path, String(child.pid))',
      'child.unref()',
    ].join(';');
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: ['-e', script, pidPath],
      cwd: dir,
    });

    try {
      await managed.exited;
      const pid = Number(readFileSync(pidPath, 'utf8'));
      await managed.dispose();
      await expectProcessMissing(pid);
    } finally {
      await managed.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function expectProcessMissing(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  process.kill(pid, 'SIGKILL');
  throw new Error(`descendant process ${pid} survived managed-process cleanup`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
