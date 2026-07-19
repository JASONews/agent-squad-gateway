import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { CapabilityService } from '../../src/provider-runtime/capability-service.js';
import { registerBuiltInProviders } from '../../src/provider-runtime/register-providers.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../../src/provider-runtime/types.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { doctorGateway } from '../../src/lifecycle/daemon.js';
import { buildGatewayApp } from '../../src/server/app.js';

class StaticProbeAdapter implements ProviderAdapter {
  readonly calls: ProviderProbeRequest[] = [];

  constructor(
    private readonly capabilities: ProviderCapabilities,
    private readonly onDispose?: () => void,
  ) {}

  async probeCapabilities(request: ProviderProbeRequest = { mode: 'static' }): Promise<ProviderCapabilities> {
    this.calls.push(request);
    return this.capabilities;
  }

  start(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    throw new Error('model_turn_not_allowed');
  }

  resume(_request: ProviderResumeRequest): AsyncIterable<ProviderEvent> {
    throw new Error('model_turn_not_allowed');
  }

  async cancel(_runId: string): Promise<void> {}

  async dispose(): Promise<void> {
    this.onDispose?.();
  }
}

function staticCapabilities(): ProviderCapabilities {
  return {
    available: true,
    version: '1.0.0',
    verified: false,
    modelSelection: true,
    effortSelection: true,
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
  };
}

describe('built-in provider registration', () => {
  it('registers and statically scans every built-in provider without configured targets', async () => {
    const db = openGatewayDb(':memory:');
    const targets = new TargetRepository(db);
    const registry = new ProviderRegistry();
    const adapters = {
      antigravity: new StaticProbeAdapter(staticCapabilities()),
      claude: new StaticProbeAdapter(staticCapabilities()),
      codex: new StaticProbeAdapter(staticCapabilities()),
      cursor: new StaticProbeAdapter(staticCapabilities()),
      kimi: new StaticProbeAdapter(staticCapabilities()),
      opencode: new StaticProbeAdapter(staticCapabilities()),
    };
    registerBuiltInProviders(registry, {
      factories: {
        antigravity: () => adapters.antigravity,
        claude: () => adapters.claude,
        codex: () => adapters.codex,
        cursor: () => adapters.cursor,
        kimi: () => adapters.kimi,
        opencode: () => adapters.opencode,
      },
    });
    const workspaces = new WorkspaceManager('/tmp/agent-squad-register-providers-test', {
      getFixedWorkspaces: () => [],
    });

    try {
      const availability = await new CapabilityService(registry, targets, workspaces).scanInstalled();

      expect(registry.list()).toEqual(['antigravity', 'claude', 'codex', 'cursor', 'kimi', 'opencode']);
      expect(availability.map((entry) => entry.cli)).toEqual(registry.list());
      expect(Object.values(adapters).flatMap((adapter) => adapter.calls)).toEqual([
        { mode: 'static' },
        { mode: 'static' },
        { mode: 'static' },
        { mode: 'static' },
        { mode: 'static' },
        { mode: 'static' },
      ]);
    } finally {
      db.close();
    }
  });

  it('reconciles startup, scans statically, and stays healthy with a missing CLI', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'asq-register-startup-'));
    const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
    const db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const credentials = new CredentialService(db, Buffer.alloc(32, 1));
    const targets = new TargetRepository(db);
    const grants = new GrantRepository(db);
    const extensions = new ExtensionRepository(db);
    const runs = new RunRepository(db);
    const adminAuth = new AdminAuthService(db, Buffer.alloc(32, 2));
    const registry = new ProviderRegistry();
    const adapters = {
      antigravity: new StaticProbeAdapter(staticCapabilities()),
      claude: new StaticProbeAdapter({
        ...staticCapabilities(),
        available: false,
        version: undefined,
        error: 'binary_unavailable',
      }),
      codex: new StaticProbeAdapter({ ...staticCapabilities(), version: '2.0.0' }),
      cursor: new StaticProbeAdapter(staticCapabilities()),
      kimi: new StaticProbeAdapter(staticCapabilities()),
      opencode: new StaticProbeAdapter(staticCapabilities()),
    };
    registerBuiltInProviders(registry, {
      factories: {
        antigravity: () => adapters.antigravity,
        claude: () => adapters.claude,
        codex: () => adapters.codex,
        cursor: () => adapters.cursor,
        kimi: () => adapters.kimi,
        opencode: () => adapters.opencode,
      },
    });
    targets.create({
      id: 'codex-version-change',
      cli: 'codex',
      nativeModel: 'gpt-test',
      reasoningEffort: 'high',
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });
    targets.setCapability('codex-version-change', {
      version: '1.0.0',
      verifiedAt: '2026-07-12T12:00:00.000Z',
      capabilities: {
        modelSelection: true,
        effortSelection: true,
        isolationLevel: 'best_effort',
        streamingMode: 'native',
        toolBridge: 'structured_output',
        resume: true,
        cancellation: true,
      },
    });
    targets.update('codex-version-change', { enabled: true, enabledBestEffort: true });
    const workspaces = new WorkspaceManager(config.paths.workspacesDir, {
      getFixedWorkspaces: () => [],
    });
    const capabilityService = new CapabilityService(registry, targets, workspaces);
    const lifecycle: string[] = [];
    const retention = {
      reconcileStartup: vi.fn(async () => { lifecycle.push('reconcile'); }),
      sweep: vi.fn(async () => { lifecycle.push('sweep'); }),
      start: vi.fn(() => { lifecycle.push('retention-start'); }),
      stop: vi.fn(async () => { lifecycle.push('retention-stop'); }),
    };
    const app = buildGatewayApp({
      config,
      db,
      clients,
      credentials,
      targets,
      grants,
      extensions,
      runs,
      adminAuth,
      providers: registry,
      capabilityService,
      scanCapabilitiesOnReady: true,
      retention,
    });

    try {
      await app.ready();

      expect(lifecycle.slice(0, 3)).toEqual(['reconcile', 'sweep', 'retention-start']);
      expect(Object.values(adapters).flatMap((adapter) => adapter.calls))
        .toEqual(Array.from({ length: 6 }, () => ({ mode: 'static' })));
      expect(capabilityService.listAvailability()).toEqual(expect.arrayContaining([
        expect.objectContaining({ cli: 'claude', capabilities: expect.objectContaining({ available: false }) }),
      ]));
      expect(targets.get('codex-version-change')).toMatchObject({
        enabled: false,
        capabilityVersion: '1.0.0',
        capabilityVerifiedAt: null,
        capabilityError: 'conformance_required',
      });
      await expect(app.inject({ method: 'GET', url: '/health' }))
        .resolves.toMatchObject({ statusCode: 200 });
      const mint = await app.inject({
        method: 'POST',
        url: '/admin/bootstrap/mint',
        headers: { authorization: `Bearer ${Buffer.alloc(32, 2).toString('base64url')}` },
        payload: {},
      });
      const exchange = await app.inject({
        method: 'POST',
        url: '/admin/bootstrap/exchange',
        payload: { code: (mint.json() as { code: string }).code },
      });
      const login = exchange.json() as { csrf_token: string };
      const refresh = await app.inject({
        method: 'POST',
        url: '/admin/cli-availability/refresh',
        headers: {
          cookie: exchange.headers['set-cookie']!.split(';', 1)[0]!,
          origin: `http://${config.host}:${config.port}`,
          'x-csrf-token': login.csrf_token,
        },
        payload: {},
      });
      expect(refresh.statusCode).toBe(200);
      expect((refresh.json() as { cli_availability: unknown[] }).cli_availability)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ cli: 'claude', capabilities: expect.objectContaining({ available: false }) }),
        ]));
    } finally {
      await app.close();
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('aborts active runs before a later preClose drain observer and continues ordered cleanup', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'asq-register-close-'));
    const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
    const db = openGatewayDb(':memory:');
    const targets = new TargetRepository(db);
    const registry = new ProviderRegistry();
    const events: string[] = [];
    const drainObservations: string[][] = [];
    const closingStatusCodes: number[] = [];
    registerBuiltInProviders(registry, {
      factories: {
        antigravity: () => new StaticProbeAdapter(staticCapabilities()),
        claude: () => new StaticProbeAdapter(staticCapabilities()),
        codex: () => new StaticProbeAdapter(staticCapabilities(), () => { events.push('codex-close'); }),
        cursor: () => new StaticProbeAdapter(staticCapabilities(), () => { events.push('cursor-close'); }),
        kimi: () => new StaticProbeAdapter(staticCapabilities(), () => { events.push('kimi-close'); }),
        opencode: () => new StaticProbeAdapter(staticCapabilities(), () => { events.push('opencode-close'); }),
      },
    });
    const app = buildGatewayApp({
      config,
      db,
      clients: new ClientRepository(db),
      credentials: new CredentialService(db, Buffer.alloc(32, 1)),
      targets,
      grants: new GrantRepository(db),
      extensions: new ExtensionRepository(db),
      runs: new RunRepository(db),
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 2)),
      providers: registry,
      invocationService: {
        invoke: () => { throw new Error('model_turn_not_allowed'); },
        abortActive: async () => {
          events.push('abort-runs');
          throw new Error('abort failed');
        },
      },
      retention: {
        reconcileStartup: async () => {},
        sweep: async () => {},
        start: () => {},
        stop: async () => { events.push('retention-stop'); },
      },
    });
    app.addHook('preClose', async () => {
      drainObservations.push([...events]);
      closingStatusCodes.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
      events.push('in-flight-drain');
    });

    try {
      await app.ready();
      await expect(app.close()).rejects.toThrow('abort failed');

      expect(events.filter((event) => event !== 'in-flight-drain')).toEqual([
        'abort-runs',
        'codex-close',
        'cursor-close',
        'kimi-close',
        'opencode-close',
        'retention-stop',
      ]);
      expect(drainObservations.length).toBeGreaterThan(0);
      expect(drainObservations.every((observation) => observation.includes('abort-runs'))).toBe(true);
      expect(closingStatusCodes.every((statusCode) => statusCode === 503)).toBe(true);
    } finally {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('reports static provider ceilings and verify-required targets without conformance', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'asq-register-doctor-'));
    const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
    const db = openGatewayDb(config.paths.dbPath);
    const targets = new TargetRepository(db);
    targets.create({
      id: 'codex-stale',
      cli: 'codex',
      nativeModel: 'gpt-test',
      reasoningEffort: 'high',
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });
    targets.setCapability('codex-stale', {
      version: '1.0.0',
      verifiedAt: '2026-07-12T12:00:00.000Z',
      capabilities: {
        modelSelection: true,
        effortSelection: true,
        isolationLevel: 'best_effort',
        streamingMode: 'native',
        toolBridge: 'structured_output',
        resume: true,
        cancellation: true,
      },
    });
    db.close();
    const registry = new ProviderRegistry();
    const adapters = {
      antigravity: new StaticProbeAdapter(staticCapabilities()),
      claude: new StaticProbeAdapter(staticCapabilities()),
      codex: new StaticProbeAdapter({ ...staticCapabilities(), version: '2.0.0' }),
      cursor: new StaticProbeAdapter(staticCapabilities()),
      kimi: new StaticProbeAdapter(staticCapabilities()),
      opencode: new StaticProbeAdapter(staticCapabilities()),
    };
    registerBuiltInProviders(registry, {
      factories: {
        antigravity: () => adapters.antigravity,
        claude: () => adapters.claude,
        codex: () => adapters.codex,
        cursor: () => adapters.cursor,
        kimi: () => adapters.kimi,
        opencode: () => adapters.opencode,
      },
    });
    const output = vi.fn();

    try {
      const report = await doctorGateway({
        baseDir,
        providers: registry,
        resolveProviderBinary: (cli) => `/opt/bin/${cli}`,
        fetch: vi.fn(async () => { throw new Error('core offline'); }),
        output,
      });

      expect(Object.values(adapters).flatMap((adapter) => adapter.calls))
        .toEqual(Array.from({ length: 6 }, () => ({ mode: 'static' })));
      expect(report.core).toBe('unreachable');
      expect(report.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          cli: 'codex',
          binaryPath: '/opt/bin/codex',
          version: '2.0.0',
          staticCeiling: expect.objectContaining({
            streamingMode: 'native',
            toolBridge: 'structured_output',
          }),
          targets: [expect.objectContaining({ id: 'codex-stale', status: 'verify-required' })],
        }),
      ]));
      expect(output.mock.calls.flat().join('\n')).toContain('verify-required');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
