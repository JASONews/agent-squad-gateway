import { describe, expect, it } from 'vitest';
import { resolveGatewayPaths } from '../../src/config/paths.js';
import {
  formatGatewayAddress,
  gatewayBindPolicy,
  gatewayLoopbackOrigin,
  resolveGatewayConfig,
} from '../../src/config/config.js';

describe('Gateway paths and config', () => {
  it('keeps every state file under an injected home', () => {
    expect(resolveGatewayPaths('/tmp/user')).toEqual({
      stateDir: '/tmp/user/.agent-squad/gateway',
      configPath: '/tmp/user/.agent-squad/gateway/config.json',
      dbPath: '/tmp/user/.agent-squad/gateway/gateway.db',
      pidPath: '/tmp/user/.agent-squad/gateway/gateway.pid',
      logPath: '/tmp/user/.agent-squad/gateway/gateway.log',
      masterKeyPath: '/tmp/user/.agent-squad/gateway/master.key',
      adminSecretPath: '/tmp/user/.agent-squad/gateway/admin-secret',
      workspacesDir: '/tmp/user/.agent-squad/gateway/workspaces',
    });
  });

  it('binds the Gateway for containers while keeping Core on loopback', () => {
    const config = resolveGatewayConfig({ baseDir: '/tmp/user' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(28772);
    expect(config.coreUrl).toBe('http://127.0.0.1:28771');
    expect(config.webUiAuth).toBe('disabled');
    expect(resolveGatewayConfig({ webUiAuth: 'token' }).webUiAuth).toBe('token');
    expect(resolveGatewayConfig({ address: '127.0.0.1', port: 30_000 }).host).toBe('127.0.0.1');
    expect(gatewayBindPolicy('127.0.0.1')).toBe('loopback');
    expect(gatewayBindPolicy('192.0.2.10')).toBe('configured-address');
    expect(formatGatewayAddress('::1', 28_772)).toBe('[::1]:28772');
    expect(gatewayLoopbackOrigin(resolveGatewayConfig({ address: '::', port: 28_772 })))
      .toBe('http://[::1]:28772');
  });
});
