import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import type { UpdateTargetInput } from '../../src/control-plane/types.js';

const VERIFIED_AT = '2026-07-12T12:00:00.000Z';

describe('TargetRepository verification freshness', () => {
  let db: GatewayDb;
  let targets: TargetRepository;

  beforeEach(() => {
    db = openGatewayDb(':memory:');
    targets = new TargetRepository(db);
  });

  afterEach(() => db.close());

  function verifiedTarget() {
    targets.create({
      id: 'codex-test', cli: 'codex', nativeModel: 'gpt-test', reasoningEffort: 'high',
      isolationLevel: 'best_effort', streamingMode: 'native', toolBridge: 'structured_output',
    });
    targets.setCapability('codex-test', {
      version: '1.2.0',
      verifiedAt: VERIFIED_AT,
      capabilities: {
        isolationLevel: 'strict', streamingMode: 'native', toolBridge: 'structured_output',
        resume: true, cancellation: true, modelSelection: true, effortSelection: true,
      },
    });
    return targets.update('codex-test', { enabled: true, enabledBestEffort: true });
  }

  it.each<[string, UpdateTargetInput]>([
    ['CLI', { cli: 'claude' }],
    ['native model', { nativeModel: 'gpt-next' }],
    ['reasoning effort', { reasoningEffort: 'max' }],
    ['isolation', { isolationLevel: 'strict' }],
    ['streaming', { streamingMode: 'none' }],
    ['tool mode', { toolBridge: 'none' }],
  ])('atomically disables and invalidates verification when %s changes', (_name, patch) => {
    verifiedTarget();

    const updated = targets.update('codex-test', patch);

    expect(updated).toMatchObject({
      ...patch,
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
  });

  it('does not invalidate verification for queue-only changes', () => {
    verifiedTarget();
    expect(targets.update('codex-test', { maxQueue: 12 })).toMatchObject({
      enabled: true,
      maxQueue: 12,
      capabilityVersion: '1.2.0',
      capabilityVerifiedAt: VERIFIED_AT,
      capabilityError: null,
    });
  });

  it('preserves the prior verified version when invalidating for a static mismatch', () => {
    verifiedTarget();

    expect(targets.invalidateCapability(
      'codex-test',
      '2.0.0',
      'conformance_required',
      true,
    )).toMatchObject({
      enabled: false,
      capabilityVersion: '1.2.0',
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'conformance_required',
    });
    expect(targets.invalidateCapability(
      'codex-test',
      '2.0.0',
      'conformance_required',
      true,
    )).toMatchObject({ capabilityVersion: '1.2.0' });
  });

  it('invalidates verification when the fixed workspace changes', () => {
    verifiedTarget();
    expect(targets.update('codex-test', {
      fixedWorkspace: process.cwd(), acknowledgeFixedWorkspaceDowngrade: true,
    })).toMatchObject({
      enabled: false,
      fixedWorkspace: process.cwd(),
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
      capabilityError: 'configuration_changed',
    });
  });

  it('rejects whitespace-only fixed workspaces before persisting best effort', () => {
    expect(() => targets.create({
      id: 'bad-workspace', cli: 'codex', nativeModel: 'gpt-test',
      isolationLevel: 'best_effort', fixedWorkspace: '   ',
      acknowledgeFixedWorkspaceDowngrade: true,
    })).toThrowError('fixed_workspace_required_for_best_effort');
    expect(targets.get('bad-workspace')).toBeNull();
  });
});
