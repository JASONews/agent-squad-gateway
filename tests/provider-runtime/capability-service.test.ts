import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import type { InvocationTarget, TargetCapabilities } from '../../src/control-plane/types.js';
import {
  CapabilityService,
  capabilityMismatches,
} from '../../src/provider-runtime/capability-service.js';
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
import { ensureSecretFile } from '../../src/security/secret-files.js';
import { buildGatewayApp } from '../../src/server/app.js';

const VERIFIED_AT = '2026-07-12T12:00:00.000Z';

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    available: true,
    version: '2.0.0',
    verified: false,
    modelSelection: true,
    effortSelection: true,
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    ...overrides,
  };
}

function persistedCapabilities(overrides: Partial<TargetCapabilities> = {}): TargetCapabilities {
  return {
    modelSelection: true,
    effortSelection: true,
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class RecordingAdapter implements ProviderAdapter {
  readonly calls: ProviderProbeRequest[] = [];
  readonly conformanceStarted: Promise<void>;
  private resolveConformanceStarted!: () => void;

  constructor(
    private readonly staticCapabilities: ProviderCapabilities | Promise<ProviderCapabilities>,
    private readonly conformanceCapabilities: ProviderCapabilities | Promise<ProviderCapabilities>
      = capabilities({ verified: true, verifiedAt: VERIFIED_AT }),
  ) {
    this.conformanceStarted = new Promise((resolve) => {
      this.resolveConformanceStarted = resolve;
    });
  }

  async probeCapabilities(request: ProviderProbeRequest = { mode: 'static' }): Promise<ProviderCapabilities> {
    this.calls.push(request);
    if (request.mode === 'static') return this.staticCapabilities;
    this.resolveConformanceStarted();
    return this.conformanceCapabilities;
  }

  start(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    throw new Error('model_turn_not_allowed_in_capability_service_test');
  }

  resume(_request: ProviderResumeRequest): AsyncIterable<ProviderEvent> {
    throw new Error('model_turn_not_allowed_in_capability_service_test');
  }

  async cancel(_runId: string): Promise<void> {}
}

describe('CapabilityService', () => {
  let db: GatewayDb;
  let targets: TargetRepository;
  let providers: ProviderRegistry;
  let workspaceRoot: string;
  let workspaces: WorkspaceManager;

  beforeEach(() => {
    db = openGatewayDb(':memory:');
    targets = new TargetRepository(db);
    providers = new ProviderRegistry();
    workspaceRoot = mkdtempSync(join(tmpdir(), 'asq-capability-'));
    workspaces = new WorkspaceManager(workspaceRoot, {
      getFixedWorkspaces: () => targets.list()
        .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function createTarget(id = 'codex-test', overrides: Partial<{
    cli: string;
    nativeModel: string;
    reasoningEffort: string | null;
    isolationLevel: 'strict' | 'best_effort';
    streamingMode: 'native' | 'none';
    toolBridge: 'structured_output' | 'none';
  }> = {}): InvocationTarget {
    return targets.create({
      id,
      cli: overrides.cli ?? 'codex',
      nativeModel: overrides.nativeModel ?? 'gpt-test',
      reasoningEffort: overrides.reasoningEffort === undefined ? 'high' : overrides.reasoningEffort,
      isolationLevel: overrides.isolationLevel ?? 'best_effort',
      streamingMode: overrides.streamingMode ?? 'native',
      toolBridge: overrides.toolBridge ?? 'structured_output',
    });
  }

  function seedVerified(id: string, version: string, values = persistedCapabilities()): InvocationTarget {
    targets.setCapability(id, { version, verifiedAt: VERIFIED_AT, capabilities: values });
    return targets.update(id, { enabled: true, enabledBestEffort: true });
  }

  it('never runs conformance during startup and invalidates changed versions', async () => {
    createTarget();
    seedVerified('codex-test', '1.0.0');
    const adapter = new RecordingAdapter(capabilities({ version: '2.0.0' }));
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    await service.scanInstalled();

    expect(adapter.calls).toEqual([{ mode: 'static' }]);
    expect(targets.get('codex-test')).toMatchObject({
      enabled: false,
      capabilityVersion: '1.0.0',
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'conformance_required',
    });
  });

  it('probes installed CLIs concurrently while preserving sorted results', async () => {
    const slowCapabilities = deferred<ProviderCapabilities>();
    const slow = new RecordingAdapter(slowCapabilities.promise);
    const fast = new RecordingAdapter(capabilities({ version: '3.0.0' }));
    providers.register('alpha', slow);
    providers.register('beta', fast);
    const service = new CapabilityService(providers, targets, workspaces);

    const scan = service.scanInstalled();
    await vi.waitFor(() => expect(fast.calls).toEqual([{ mode: 'static' }]));
    slowCapabilities.resolve(capabilities({ version: '1.0.0' }));

    await expect(scan).resolves.toEqual([
      expect.objectContaining({ cli: 'alpha', capabilities: expect.objectContaining({ version: '1.0.0' }) }),
      expect.objectContaining({ cli: 'beta', capabilities: expect.objectContaining({ version: '3.0.0' }) }),
    ]);
  });

  it('does not invalidate a target verified while its static scan is in flight', async () => {
    createTarget();
    const staticCapabilities = deferred<ProviderCapabilities>();
    const adapter = new RecordingAdapter(staticCapabilities.promise);
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    const scan = service.scanInstalled();
    await vi.waitFor(() => expect(adapter.calls).toEqual([{ mode: 'static' }]));
    targets.setCapability('codex-test', {
      version: '2.0.0',
      verifiedAt: VERIFIED_AT,
      capabilities: persistedCapabilities(),
    });
    targets.update('codex-test', { enabled: true, enabledBestEffort: true });
    staticCapabilities.resolve(capabilities({ version: '2.0.0' }));
    await scan;

    expect(targets.get('codex-test')).toMatchObject({
      enabled: true,
      capabilityVersion: '2.0.0',
      capabilityVerifiedAt: VERIFIED_AT,
      capabilityError: null,
    });
  });

  it('invalidates targets whose CLI is unavailable', async () => {
    createTarget();
    seedVerified('codex-test', '1.0.0');
    const adapter = new RecordingAdapter(capabilities({
      available: false,
      version: undefined,
      error: 'binary_unavailable',
    }));
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    const availability = await service.scanInstalled();

    expect(availability).toHaveLength(1);
    expect(availability[0]).toMatchObject({ cli: 'codex', capabilities: { available: false } });
    expect(targets.get('codex-test')).toMatchObject({
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilityError: 'binary_unavailable',
    });
  });

  it('keeps unchanged verified versions enabled and model options transient', async () => {
    createTarget();
    seedVerified('codex-test', '2.0.0', persistedCapabilities({ cancellation: false }));
    const adapter = new RecordingAdapter(capabilities({
      version: '2.0.0',
      verified: false,
      modelOptions: [{ id: 'gpt-test', label: 'GPT Test', effortOptions: ['high'] }],
    }));
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    const availability = await service.scanInstalled();

    expect(targets.get('codex-test')).toMatchObject({
      enabled: true,
      capabilityVersion: '2.0.0',
      capabilityVerifiedAt: VERIFIED_AT,
      capabilities: { cancellation: false },
      capabilityError: null,
    });
    expect(availability[0]?.capabilities.modelOptions).toEqual([
      { id: 'gpt-test', label: 'GPT Test', effortOptions: ['high'] },
    ]);
    expect(service.listAvailability()).toEqual(availability);
  });

  it('requires explicit model-usage confirmation before verification', async () => {
    createTarget('claude-default-max', { cli: 'claude', nativeModel: 'default' });
    const adapter = new RecordingAdapter(capabilities());
    providers.register('claude', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    await expect(service.verifyTarget('claude-default-max', false))
      .rejects.toMatchObject({ code: 'model_usage_confirmation_required' });
    expect(adapter.calls).not.toContainEqual(expect.objectContaining({ mode: 'conformance' }));
  });

  it('rejects weaker conformance capabilities and releases the workspace', async () => {
    createTarget('strict-target', { isolationLevel: 'strict' });
    const adapter = new RecordingAdapter(
      capabilities(),
      capabilities({ verified: true, verifiedAt: VERIFIED_AT, isolationLevel: 'best_effort' }),
    );
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    await expect(service.verifyTarget('strict-target', true))
      .rejects.toMatchObject({ code: 'capability_mismatch' });

    const request = adapter.calls.find((call) => call.mode === 'conformance');
    expect(request).toMatchObject({
      mode: 'conformance',
      targetId: 'strict-target',
      model: 'gpt-test',
      effort: 'high',
    });
    if (request?.mode !== 'conformance') throw new Error('missing_conformance_request');
    expect(existsSync(request.workspace)).toBe(false);
    expect(targets.get('strict-target')).toMatchObject({
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
    });
  });

  it('stores successful verification without silently enabling the target', async () => {
    createTarget();
    const verified = {
      ...capabilities({
      version: '2.0.0',
      verified: true,
      verifiedAt: VERIFIED_AT,
      isolationLevel: 'strict',
      }),
      details: ['provider warning'],
    };
    const adapter = new RecordingAdapter(capabilities(), verified);
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    await expect(service.verifyTarget('codex-test', true)).resolves.toEqual(verified);

    expect(targets.get('codex-test')).toMatchObject({
      enabled: false,
      capabilityVersion: '2.0.0',
      capabilityVerifiedAt: VERIFIED_AT,
      capabilityError: null,
      capabilities: {
        isolationLevel: 'strict',
        streamingMode: 'native',
        toolBridge: 'structured_output',
        resume: true,
        cancellation: true,
        modelSelection: true,
        effortSelection: true,
        details: ['provider warning'],
      },
    });
  });

  it('discards conformance when the target execution contract changes during the probe', async () => {
    createTarget();
    const conformance = deferred<ProviderCapabilities>();
    const adapter = new RecordingAdapter(capabilities(), conformance.promise);
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    const verification = service.verifyTarget('codex-test', true);
    await adapter.conformanceStarted;
    targets.update('codex-test', { nativeModel: 'gpt-edited' });
    conformance.resolve(capabilities({ verified: true, verifiedAt: VERIFIED_AT }));

    await expect(verification).rejects.toMatchObject({
      code: 'target_changed_during_verification',
    });
    expect(targets.get('codex-test')).toMatchObject({
      nativeModel: 'gpt-edited',
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
    expect(() => targets.update('codex-test', { enabled: true, enabledBestEffort: true }))
      .toThrowError('capability_verification_required');
  });

  it('discards conformance when the target is deleted and recreated during the probe', async () => {
    createTarget();
    const conformance = deferred<ProviderCapabilities>();
    const adapter = new RecordingAdapter(capabilities(), conformance.promise);
    providers.register('codex', adapter);
    const service = new CapabilityService(providers, targets, workspaces);

    const verification = service.verifyTarget('codex-test', true);
    await adapter.conformanceStarted;
    targets.delete('codex-test');
    createTarget();
    conformance.resolve(capabilities({ verified: true, verifiedAt: VERIFIED_AT }));

    await expect(verification).rejects.toMatchObject({
      code: 'target_changed_during_verification',
    });
    expect(targets.get('codex-test')).toMatchObject({
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: null,
    });
    expect(() => targets.update('codex-test', { enabled: true, enabledBestEffort: true }))
      .toThrowError('capability_verification_required');
  });

  it('reports every capability that is weaker than target configuration', () => {
    const target = {
      ...createTarget('configured', { isolationLevel: 'strict' }),
      capabilities: persistedCapabilities({ resume: true, cancellation: true }),
    };

    expect(capabilityMismatches(target, capabilities({
      verified: true,
      isolationLevel: 'best_effort',
      streamingMode: 'none',
      toolBridge: 'none',
      modelSelection: false,
      effortSelection: false,
      resume: false,
      cancellation: false,
    }))).toEqual([
      'isolationLevel',
      'streamingMode',
      'toolBridge',
      'modelSelection',
      'effortSelection',
    ]);
  });
});

describe('capability admin routes', () => {
  it('enforces admin protections and exposes explicit model usage', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'asq-capability-routes-'));
    const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
    const adminSecretBytes = Buffer.from('capability-route-admin-secret');
    const adminSecret = adminSecretBytes.toString('base64url');
    const db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const masterKey = ensureSecretFile(config.paths.masterKeyPath, 32);
    writeFileSync(config.paths.adminSecretPath, adminSecretBytes, { mode: 0o600 });
    const credentials = new CredentialService(db, masterKey);
    const targets = new TargetRepository(db);
    const extensions = new ExtensionRepository(db);
    const grants = new GrantRepository(db);
    const runs = new RunRepository(db);
    const adminAuth = new AdminAuthService(db, readFileSync(config.paths.adminSecretPath));
    const providers = new ProviderRegistry();
    const adapter = new RecordingAdapter(
      capabilities({ version: '2.0.0' }),
      capabilities({ version: '2.0.0', verified: true, verifiedAt: VERIFIED_AT }),
    );
    providers.register('codex', adapter);
    targets.create({
      id: 'codex-test',
      cli: 'codex',
      nativeModel: 'gpt-test',
      reasoningEffort: 'high',
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });
    const workspaces = new WorkspaceManager(config.paths.workspacesDir, {
      getFixedWorkspaces: () => [],
    });
    const capabilityService = new CapabilityService(providers, targets, workspaces);
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
      capabilityService,
    });
    await app.ready();

    try {
      const unauthorized = await app.inject({
        method: 'POST',
        url: '/admin/cli-availability/refresh',
        payload: {},
      });
      expect(unauthorized.statusCode).toBe(401);

      const mint = await app.inject({
        method: 'POST',
        url: '/admin/bootstrap/mint',
        headers: { authorization: `Bearer ${adminSecret}` },
        payload: {},
      });
      const code = (mint.json() as { code: string }).code;
      const exchange = await app.inject({
        method: 'POST',
        url: '/admin/bootstrap/exchange',
        payload: { code },
      });
      const login = exchange.json() as { csrf_token: string };
      const headers = {
        cookie: exchange.headers['set-cookie']!.split(';', 1)[0]!,
        origin: `http://${config.host}:${config.port}`,
        'x-csrf-token': login.csrf_token,
      };

      const invalidRefresh = await app.inject({
        method: 'POST',
        url: '/admin/cli-availability/refresh',
        headers,
        payload: { run_model: true },
      });
      expect(invalidRefresh.statusCode).toBe(400);

      const refresh = await app.inject({
        method: 'POST',
        url: '/admin/cli-availability/refresh',
        headers,
        payload: {},
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).toMatchObject({
        cli_availability: [{ cli: 'codex', capabilities: { available: true, verified: false } }],
      });
      expect(adapter.calls).toEqual([{ mode: 'static' }]);

      const invalidVerify = await app.inject({
        method: 'POST',
        url: '/admin/targets/codex-test/verify',
        headers,
        payload: { confirm_model_usage: false },
      });
      expect(invalidVerify.statusCode).toBe(400);
      expect(adapter.calls).toEqual([{ mode: 'static' }]);

      const verify = await app.inject({
        method: 'POST',
        url: '/admin/targets/codex-test/verify',
        headers,
        payload: { confirm_model_usage: true },
      });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        capabilities: { available: true, verified: true, version: '2.0.0' },
        model_usage_consumed: true,
      });
      expect(adapter.calls.filter((call) => call.mode === 'conformance')).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
