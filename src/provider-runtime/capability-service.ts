import { randomUUID } from 'node:crypto';
import type { TargetRepository } from '../control-plane/targets.js';
import type { InvocationTarget, TargetCapabilities } from '../control-plane/types.js';
import { GatewayError } from '../server/errors.js';
import type { ProviderRegistry } from './registry.js';
import type { ProviderCapabilities } from './types.js';
import type { WorkspaceManager } from './workspaces.js';

const CONFORMANCE_TIMEOUT_MS = 2 * 60 * 1_000;

export interface CliAvailability {
  cli: string;
  scannedAt: string;
  capabilities: ProviderCapabilities;
}

function supportsIsolation(
  required: InvocationTarget['isolationLevel'],
  actual: ProviderCapabilities['isolationLevel'],
): boolean {
  return required === 'best_effort' || actual === 'strict';
}

function supportsStreaming(
  required: InvocationTarget['streamingMode'],
  actual: ProviderCapabilities['streamingMode'],
): boolean {
  return required === 'none' || actual === 'native';
}

function supportsToolBridge(
  required: InvocationTarget['toolBridge'],
  actual: ProviderCapabilities['toolBridge'],
): boolean {
  return required === 'none' || actual === 'structured_output';
}

export function capabilityMismatches(
  target: InvocationTarget,
  actual: ProviderCapabilities,
): string[] {
  const mismatches: string[] = [];
  if (!supportsIsolation(target.isolationLevel, actual.isolationLevel)) mismatches.push('isolationLevel');
  if (!supportsStreaming(target.streamingMode, actual.streamingMode)) mismatches.push('streamingMode');
  if (!supportsToolBridge(target.toolBridge, actual.toolBridge)) mismatches.push('toolBridge');
  if (!actual.modelSelection) mismatches.push('modelSelection');
  if (target.reasoningEffort !== null && !actual.effortSelection) mismatches.push('effortSelection');
  return mismatches;
}

function persistedCapabilities(actual: ProviderCapabilities): TargetCapabilities {
  return {
    isolationLevel: actual.isolationLevel,
    streamingMode: actual.streamingMode,
    toolBridge: actual.toolBridge,
    resume: actual.resume,
    cancellation: actual.cancellation,
    modelSelection: actual.modelSelection,
    effortSelection: actual.effortSelection,
    ...(actual.details === undefined ? {} : { details: [...actual.details] }),
  };
}

function safeErrorCode(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : fallback;
}

function unavailableCapabilities(error: string): ProviderCapabilities {
  return {
    available: false,
    verified: false,
    modelSelection: false,
    effortSelection: false,
    isolationLevel: 'best_effort',
    streamingMode: 'none',
    toolBridge: 'none',
    resume: false,
    cancellation: false,
    error,
  };
}

function cloneCapabilities(capabilities: ProviderCapabilities): ProviderCapabilities {
  return {
    ...capabilities,
    modelOptions: capabilities.modelOptions?.map((option) => ({
      ...option,
      effortOptions: option.effortOptions === null ? null : [...option.effortOptions],
    })),
    ...(capabilities.details === undefined ? {} : { details: [...capabilities.details] }),
  };
}

function isVerifiedCapability(capabilities: ProviderCapabilities): capabilities is ProviderCapabilities & {
  version: string;
  verifiedAt: string;
} {
  if (!capabilities.available || !capabilities.verified
    || typeof capabilities.version !== 'string' || capabilities.version.length === 0
    || typeof capabilities.verifiedAt !== 'string') {
    return false;
  }
  const timestamp = Date.parse(capabilities.verifiedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === capabilities.verifiedAt;
}

export class CapabilityService {
  private availability: CliAvailability[] = [];

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly targets: TargetRepository,
    private readonly workspaces: WorkspaceManager,
  ) {}

  async scanInstalled(): Promise<CliAvailability[]> {
    const targets = this.targets.list();
    const cliNames = [...new Set([
      ...this.providers.list(),
      ...targets.map((target) => target.cli),
    ])].sort();
    const scanned = await Promise.all(cliNames.map(async (cli): Promise<CliAvailability> => {
      const scannedAt = new Date().toISOString();
      let capabilities: ProviderCapabilities;
      try {
        const adapter = this.providers.require(cli);
        capabilities = await adapter.probeCapabilities({ mode: 'static' });
      } catch (error) {
        capabilities = unavailableCapabilities(safeErrorCode(error, 'provider_unavailable'));
      }

      if (capabilities.available
        && (typeof capabilities.version !== 'string' || capabilities.version.length === 0)) {
        capabilities = unavailableCapabilities('capability_probe_failed');
      }
      return { cli, scannedAt, capabilities: cloneCapabilities(capabilities) };
    }));

    for (const { cli, capabilities } of scanned) {
      const cliTargets = targets.filter((target) => target.cli === cli);
      if (!capabilities.available) {
        const error = typeof capabilities.error === 'string' && capabilities.error.length > 0
          ? capabilities.error
          : 'provider_unavailable';
        for (const target of cliTargets) {
          this.targets.invalidateCapabilityIfUnchanged(target, null, error);
        }
        continue;
      }

      const version = capabilities.version!;
      for (const target of cliTargets) {
        const hasValidPersistedRecord = target.capabilityVersion === version
          && target.capabilityVerifiedAt !== null
          && target.capabilities !== null
          && target.capabilityError === null;
        if (!hasValidPersistedRecord) {
          this.targets.invalidateCapabilityIfUnchanged(
            target,
            version,
            'conformance_required',
            true,
          );
        }
      }
    }

    this.availability = scanned;
    return this.listAvailability();
  }

  listAvailability(): CliAvailability[] {
    return this.availability.map((entry) => ({
      ...entry,
      capabilities: cloneCapabilities(entry.capabilities),
    }));
  }

  async verifyTarget(targetId: string, confirmModelUsage: boolean): Promise<ProviderCapabilities> {
    if (confirmModelUsage !== true) {
      throw new GatewayError(
        400,
        'model_usage_confirmation_required',
        'model usage confirmation required',
      );
    }

    const target = this.targets.get(targetId);
    if (target === null) throw new GatewayError(404, 'target_not_found', 'target not found');

    let adapter;
    try {
      adapter = this.providers.require(target.cli);
    } catch {
      throw new GatewayError(409, 'provider_unavailable', 'provider unavailable');
    }

    const temporaryTarget: InvocationTarget = {
      ...target,
      fixedWorkspace: null,
      isolationLevel: 'best_effort',
    };
    const lease = await this.workspaces.acquireChat(
      temporaryTarget,
      `capability-${randomUUID()}`,
    );

    try {
      const actual = await adapter.probeCapabilities({
        mode: 'conformance',
        targetId: target.id,
        model: target.nativeModel,
        effort: target.reasoningEffort,
        workspace: lease.path,
        signal: AbortSignal.timeout(CONFORMANCE_TIMEOUT_MS),
      });
      if (!isVerifiedCapability(actual)) {
        throw new GatewayError(409, 'capability_verification_failed', 'capability verification failed');
      }
      if (capabilityMismatches(target, actual).length > 0) {
        throw new GatewayError(409, 'capability_mismatch', 'capability mismatch');
      }

      const stored = this.targets.setCapabilityIfUnchanged(target, {
        version: actual.version,
        verifiedAt: actual.verifiedAt,
        capabilities: persistedCapabilities(actual),
      });
      if (!stored) {
        throw new GatewayError(
          409,
          'target_changed_during_verification',
          'target changed during verification',
        );
      }
      return cloneCapabilities(actual);
    } finally {
      await lease.release();
    }
  }
}
