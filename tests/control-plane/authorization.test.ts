import { afterEach, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { TargetRepository } from '../../src/control-plane/targets.js';

let db: GatewayDb | undefined;

afterEach(() => db?.close());

const verifiedCapabilities = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

function createTarget(targets: TargetRepository) {
  return targets.create({
    id: 'codex-gpt56-max',
    aliases: ['codex/gpt-5.6/max'],
    cli: 'codex',
    nativeModel: 'gpt-5.6',
    reasoningEffort: 'max',
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 300_000,
    runTimeoutMs: null,
  });
}

describe('Target and Grant repositories', () => {
  it('authorizes only enabled, verified, granted canonical targets and aliases', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const targets = new TargetRepository(db);
    const extensions = new ExtensionRepository(db);
    const grants = new GrantRepository(db);
    const client = clients.create('openai-client');
    const target = createTarget(targets);
    extensions.upsert('openai', '1.0.0', true);

    expect(target).toMatchObject({
      id: 'codex-gpt56-max',
      aliases: ['codex/gpt-5.6/max'],
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
    });
    expect(() => targets.update(target.id, { enabled: true }))
      .toThrow('capability_verification_required');

    expect(targets.setCapability(target.id, {
      version: '1.2.3',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: verifiedCapabilities,
    }).enabled).toBe(false);
    targets.update(target.id, { enabled: true });

    expect(() => grants.authorize(client.id, 'openai', target.id))
      .toThrow('authorization_denied');

    grants.grant(client.id, 'openai', target.id);
    expect(grants.authorize(client.id, 'openai', target.id).id).toBe(target.id);
    expect(grants.authorize(client.id, 'openai', 'codex/gpt-5.6/max').id).toBe(target.id);

    clients.setStatus(client.id, 'disabled');
    expect(() => grants.authorize(client.id, 'openai', target.id))
      .toThrow('authorization_denied');
    clients.setStatus(client.id, 'active');

    targets.update(target.id, { enabled: false });
    expect(() => grants.authorize(client.id, 'openai', target.id))
      .toThrow('authorization_denied');

    targets.update(target.id, { enabled: true });
    extensions.setEnabled('openai', false);
    expect(() => grants.authorize(client.id, 'openai', target.id))
      .toThrow('authorization_denied');

    extensions.setEnabled('openai', true);
    db.prepare(`
      UPDATE invocation_targets
      SET capability_verified_at = NULL, capability_json = NULL
      WHERE id = ?
    `).run(target.id);
    expect(() => grants.authorize(client.id, 'openai', target.id))
      .toThrow('authorization_denied');

    targets.invalidateCapability(target.id, '1.2.4', 'version_changed');
    expect(targets.get(target.id)).toMatchObject({
      enabled: false,
      capabilityVersion: '1.2.4',
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'version_changed',
    });
    expect(grants.listForClient(client.id)).toHaveLength(1);
  });

  it('requires compatible verification and explicit acknowledgements for best-effort fixed workspaces', () => {
    db = openGatewayDb(':memory:');
    const targets = new TargetRepository(db);
    const target = createTarget(targets);

    targets.setCapability(target.id, {
      version: '1.2.3',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: { ...verifiedCapabilities, modelSelection: false },
    });
    expect(() => targets.update(target.id, { enabled: true }))
      .toThrow('capability_mismatch');

    expect(() => targets.create({
      ...target,
      id: 'fixed-workspace',
      aliases: [],
      fixedWorkspace: process.cwd(),
    })).toThrow('fixed_workspace_acknowledgement_required');

    const fixed = targets.create({
      ...target,
      id: 'fixed-workspace',
      aliases: [],
      fixedWorkspace: process.cwd(),
      acknowledgeFixedWorkspaceDowngrade: true,
    });
    expect(fixed).toMatchObject({
      isolationLevel: 'best_effort',
      fixedWorkspace: realpathSync(process.cwd()),
    });

    targets.setCapability(fixed.id, {
      version: '1.2.3',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: { ...verifiedCapabilities, isolationLevel: 'best_effort' },
    });
    expect(() => targets.update(fixed.id, { enabled: true }))
      .toThrow('best_effort_acknowledgement_required');
    expect(targets.update(fixed.id, { enabled: true, enabledBestEffort: true }).enabled).toBe(true);
  });

  it('invalidates verification for execution changes and requires acknowledgement on re-enable', () => {
    db = openGatewayDb(':memory:');
    const targets = new TargetRepository(db);
    const target = createTarget(targets);

    targets.setCapability(target.id, {
      version: '1.2.3',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: verifiedCapabilities,
    });
    targets.update(target.id, { enabled: true });

    expect(targets.update(target.id, { isolationLevel: 'best_effort' })).toMatchObject({
      enabled: false,
      isolationLevel: 'best_effort',
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
    expect(() => targets.update(target.id, { enabled: true }))
      .toThrow('capability_verification_required');

    targets.setCapability(target.id, {
      version: '1.2.4',
      verifiedAt: '2026-07-10T13:00:00.000Z',
      capabilities: { ...verifiedCapabilities, isolationLevel: 'best_effort' },
    });
    expect(() => targets.update(target.id, { enabled: true }))
      .toThrow('best_effort_acknowledgement_required');
    expect(targets.update(target.id, {
      enabled: true,
      enabledBestEffort: true,
    })).toMatchObject({ enabled: true, isolationLevel: 'best_effort' });

    expect(targets.update(target.id, { cli: 'codex-updated' })).toMatchObject({
      cli: 'codex-updated',
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
    expect(() => targets.update(target.id, { enabled: true }))
      .toThrow('capability_verification_required');

    const fixed = targets.create({
      ...target,
      id: 'strict-fixed-workspace',
      aliases: [],
    });
    targets.setCapability(fixed.id, {
      version: '1.2.3',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: verifiedCapabilities,
    });
    targets.update(fixed.id, { enabled: true });

    expect(() => targets.update(fixed.id, { fixedWorkspace: process.cwd() }))
      .toThrow('fixed_workspace_acknowledgement_required');
    expect(targets.update(fixed.id, {
      fixedWorkspace: process.cwd(),
      acknowledgeFixedWorkspaceDowngrade: true,
    })).toMatchObject({
      enabled: false,
      isolationLevel: 'best_effort',
      fixedWorkspace: realpathSync(process.cwd()),
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
    expect(() => targets.update(fixed.id, { enabled: true }))
      .toThrow('capability_verification_required');

    targets.setCapability(fixed.id, {
      version: '1.2.4',
      verifiedAt: '2026-07-10T13:00:00.000Z',
      capabilities: { ...verifiedCapabilities, isolationLevel: 'best_effort' },
    });
    expect(() => targets.update(fixed.id, { enabled: true }))
      .toThrow('best_effort_acknowledgement_required');
    expect(targets.update(fixed.id, {
      enabled: true,
      enabledBestEffort: true,
    })).toMatchObject({
      enabled: true,
      isolationLevel: 'best_effort',
      fixedWorkspace: realpathSync(process.cwd()),
    });
  });

  it('keeps canonical IDs and aliases globally unique', () => {
    db = openGatewayDb(':memory:');
    const targets = new TargetRepository(db);
    const target = createTarget(targets);

    expect(() => targets.create({ ...target, id: 'Codex' })).toThrow('invalid_target_id');
    expect(() => targets.create({ ...target, id: 'other-target', aliases: [target.id] }))
      .toThrow('target_id_exists');
    expect(() => targets.create({ ...target, id: 'other-target', aliases: ['codex/gpt-5.6/max'] }))
      .toThrow('target_id_exists');
  });
});
