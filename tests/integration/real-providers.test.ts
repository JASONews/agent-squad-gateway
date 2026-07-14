import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { openGatewayDb } from '../../src/control-plane/db.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import {
  CapabilityService,
  capabilityMismatches,
} from '../../src/provider-runtime/capability-service.js';
import { registerBuiltInProviders } from '../../src/provider-runtime/register-providers.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import type { ProviderAdapter, ProviderEvent } from '../../src/provider-runtime/types.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';

const enabled = process.env.GATEWAY_REAL_CLI_TEST === '1';

interface ProviderObservation {
  starts: number;
  resumes: number;
  nativeToolEvents: number;
}

function observeEvents(
  events: AsyncIterable<ProviderEvent>,
  observation: ProviderObservation,
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    for await (const event of events) {
      if (typeof event.type === 'string' && event.type.includes('tool')) {
        observation.nativeToolEvents += 1;
      }
      yield event;
    }
  })();
}

function instrument(adapter: ProviderAdapter, observation: ProviderObservation): void {
  type Transport = (
    request: unknown,
    nativeSessionId: string | null,
    ...rest: unknown[]
  ) => AsyncIterable<ProviderEvent>;
  const runtime = adapter as unknown as Record<string, unknown>;
  const transportName = typeof runtime.stream === 'function'
    ? 'stream'
    : typeof runtime.run === 'function'
      ? 'run'
      : null;
  if (transportName === null) throw new Error('provider transport cannot be observed');
  const transport = runtime[transportName] as Transport;
  runtime[transportName] = (
    request: unknown,
    nativeSessionId: string | null,
    ...rest: unknown[]
  ) => {
    if (nativeSessionId === null) observation.starts += 1;
    else observation.resumes += 1;
    return observeEvents(transport.call(adapter, request, nativeSessionId, ...rest), observation);
  };
}

describe.skipIf(!enabled)('real Gateway providers', () => {
  it('verifies only explicitly selected existing targets', async () => {
    const targetIds = (process.env.GATEWAY_REAL_TARGETS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (targetIds.length === 0) {
      throw new Error('GATEWAY_REAL_TARGETS must contain comma-separated target IDs');
    }

    const config = resolveGatewayConfig({ baseDir: process.env.GATEWAY_REAL_GATEWAY_HOME });
    if (!existsSync(config.paths.dbPath)) {
      throw new Error(`existing Gateway test database required at ${config.paths.dbPath}`);
    }

    const db = openGatewayDb(config.paths.dbPath);
    const targets = new TargetRepository(db);
    const providers = new ProviderRegistry();
    registerBuiltInProviders(providers);
    const observations = new Map<string, ProviderObservation>();
    for (const cli of providers.list()) {
      const observation = { starts: 0, resumes: 0, nativeToolEvents: 0 };
      observations.set(cli, observation);
      instrument(providers.require(cli), observation);
    }
    const workspaces = new WorkspaceManager(config.paths.workspacesDir, {
      getFixedWorkspaces: () => targets.list()
        .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
    });
    const service = new CapabilityService(providers, targets, workspaces);
    const grantCountBefore = db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM grants',
    ).get()!.count;

    try {
      for (const id of targetIds) {
        const before = targets.get(id);
        if (!before) throw new Error(`Gateway target not found: ${id}`);
        const observation = observations.get(before.cli);
        if (!observation) throw new Error(`built-in provider not registered: ${before.cli}`);
        const startsBefore = observation.starts;
        const resumesBefore = observation.resumes;

        const verified = await service.verifyTarget(id, true);

        expect(verified.verified).toBe(true);
        expect(capabilityMismatches(before, verified)).toEqual([]);
        expect(observation.nativeToolEvents).toBe(0);
        expect(observation.starts).toBeGreaterThan(startsBefore);
        if (verified.resume) expect(observation.resumes).toBeGreaterThan(resumesBefore);
        expect(targets.get(id)?.enabled).toBe(before.enabled);
      }

      expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM grants').get()!.count)
        .toBe(grantCountBefore);
    } finally {
      await providers.dispose();
      db.close();
    }
  });
});
