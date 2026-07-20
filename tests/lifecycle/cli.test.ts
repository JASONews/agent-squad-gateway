import { describe, expect, it, vi } from 'vitest';
import { createGatewayProgram } from '../../src/bin/agent-squad-gateway.js';
import { AGENT_SQUAD_GATEWAY_VERSION } from '../../src/version.js';

describe('Gateway CLI', () => {
  it('exposes independent lifecycle commands and forwards start foreground mode', async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const status = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    const doctor = vi.fn(async () => {});
    const program = createGatewayProgram({ start, stop, status, open, doctor });

    expect(program.version()).toBe(AGENT_SQUAD_GATEWAY_VERSION);
    expect(program.commands.map((command) => command.name())).toEqual(['start', 'stop', 'status', 'open', 'doctor']);
    expect(program.commands.find((command) => command.name() === 'start')!.helpInformation())
      .toContain('agent-squad-gateway start [options]');
    expect(program.commands.find((command) => command.name() === 'start')!.helpInformation())
      .toContain('--web-ui-auth <mode>');
    expect(program.commands.find((command) => command.name() === 'start')!.helpInformation())
      .toContain('--address <address>');
    expect(program.commands.find((command) => command.name() === 'start')!.helpInformation())
      .toContain('--port <port>');

    await program.parseAsync([
      'node', 'agent-squad-gateway', 'start', '--foreground', '--address', '127.0.0.1',
      '--port', '30000', '--web-ui-auth', 'token',
    ]);
    await program.parseAsync(['node', 'agent-squad-gateway', 'stop']);
    await program.parseAsync(['node', 'agent-squad-gateway', 'status', '--port', '30000']);
    await program.parseAsync(['node', 'agent-squad-gateway', 'open', '--address', '127.0.0.1']);
    await program.parseAsync(['node', 'agent-squad-gateway', 'doctor']);

    expect(start).toHaveBeenCalledWith({
      foreground: true,
      address: '127.0.0.1',
      port: 30_000,
      webUiAuth: 'token',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith({ address: undefined, port: 30_000 });
    expect(open).toHaveBeenCalledWith({ address: '127.0.0.1', port: undefined });
    expect(doctor).toHaveBeenCalledOnce();
  });
});
