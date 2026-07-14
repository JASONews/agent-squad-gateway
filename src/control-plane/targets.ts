import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GatewayDb } from './db.js';
import type {
  CreateTargetInput,
  InvocationTarget,
  IsolationLevel,
  StreamingMode,
  TargetCapabilities,
  ToolBridge,
  UpdateTargetInput,
} from './types.js';

const TARGET_ID = /^[a-z0-9][a-z0-9._-]*$/;

export interface InvocationTargetRow {
  id: string;
  aliases_json: string;
  cli: string;
  native_model: string;
  reasoning_effort: string | null;
  enabled: number;
  isolation_level: IsolationLevel;
  streaming_mode: StreamingMode;
  tool_bridge: ToolBridge;
  max_concurrency: number;
  max_queue: number;
  queue_timeout_ms: number;
  run_timeout_ms: number | null;
  fixed_workspace: string | null;
  capability_version: string | null;
  capability_verified_at: string | null;
  capability_json: string | null;
  capability_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetConfiguration {
  aliases: string[];
  cli: string;
  nativeModel: string;
  reasoningEffort: string | null;
  isolationLevel: IsolationLevel;
  streamingMode: StreamingMode;
  toolBridge: ToolBridge;
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  runTimeoutMs: number | null;
  fixedWorkspace: string | null;
}

interface CapabilityRecordInput {
  version: string;
  verifiedAt: string;
  capabilities: TargetCapabilities;
}

let lastTargetTimestampMs = 0;

export function toInvocationTarget(row: InvocationTargetRow): InvocationTarget {
  return {
    id: row.id,
    aliases: parseAliases(row.aliases_json),
    cli: row.cli,
    nativeModel: row.native_model,
    reasoningEffort: row.reasoning_effort,
    enabled: row.enabled === 1,
    isolationLevel: row.isolation_level,
    streamingMode: row.streaming_mode,
    toolBridge: row.tool_bridge,
    maxConcurrency: row.max_concurrency,
    maxQueue: row.max_queue,
    queueTimeoutMs: row.queue_timeout_ms,
    runTimeoutMs: row.run_timeout_ms,
    fixedWorkspace: row.fixed_workspace,
    capabilityVersion: row.capability_version,
    capabilityVerifiedAt: row.capability_verified_at,
    capabilities: parseCapabilities(row.capability_json),
    capabilityError: row.capability_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hasCurrentCompatibleCapability(target: InvocationTarget): boolean {
  const capabilities = target.capabilities;
  if (!target.capabilityVersion
    || !target.capabilityVerifiedAt
    || !isUtcIsoTimestamp(target.capabilityVerifiedAt)
    || !capabilities
    || target.capabilityError !== null) {
    return false;
  }

  return supportsIsolation(target.isolationLevel, capabilities.isolationLevel)
    && supportsStreaming(target.streamingMode, capabilities.streamingMode)
    && supportsToolBridge(target.toolBridge, capabilities.toolBridge)
    && capabilities.modelSelection
    && (target.reasoningEffort === null || capabilities.effortSelection);
}

export class TargetRepository {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateTargetInput): InvocationTarget {
    const configuration = this.createConfiguration(input);
    this.assertIdentifiersAvailable(input.id, configuration.aliases);

    const now = nextTargetTimestamp();
    this.db.prepare(`
      INSERT INTO invocation_targets (
        id, aliases_json, cli, native_model, reasoning_effort, enabled,
        isolation_level, streaming_mode, tool_bridge, max_concurrency, max_queue,
        queue_timeout_ms, run_timeout_ms, fixed_workspace, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      JSON.stringify(configuration.aliases),
      configuration.cli,
      configuration.nativeModel,
      configuration.reasoningEffort,
      configuration.isolationLevel,
      configuration.streamingMode,
      configuration.toolBridge,
      configuration.maxConcurrency,
      configuration.maxQueue,
      configuration.queueTimeoutMs,
      configuration.runTimeoutMs,
      configuration.fixedWorkspace,
      now,
      now,
    );

    return this.getRequired(input.id);
  }

  update(id: string, patch: UpdateTargetInput): InvocationTarget {
    const update = this.db.transaction(() => {
      const current = this.getRequired(id);
      const configuration = this.updatedConfiguration(current, patch);
      this.assertIdentifiersAvailable(id, configuration.aliases, id);

      const executionContractChanged = hasExecutionContractChanged(current, configuration);
      const enabled = executionContractChanged ? false : (patch.enabled ?? current.enabled);
      const next: InvocationTarget = {
        ...current,
        ...configuration,
        enabled,
      };
      const entersEnabledBestEffort = next.enabled
        && next.isolationLevel === 'best_effort'
        && !(current.enabled && current.isolationLevel === 'best_effort');
      if (enabled) {
        if (!hasCurrentCompatibleCapability(next)) {
          if (!next.capabilityVersion || !next.capabilityVerifiedAt || !next.capabilities) {
            throw new Error('capability_verification_required');
          }
          throw new Error('capability_mismatch');
        }
        if (entersEnabledBestEffort && patch.enabledBestEffort !== true) {
          throw new Error('best_effort_acknowledgement_required');
        }
      }

      const now = nextTargetTimestamp(current.updatedAt);
      this.db.prepare(`
        UPDATE invocation_targets
        SET aliases_json = ?, cli = ?, native_model = ?, reasoning_effort = ?, enabled = ?,
            isolation_level = ?, streaming_mode = ?, tool_bridge = ?, max_concurrency = ?,
            max_queue = ?, queue_timeout_ms = ?, run_timeout_ms = ?, fixed_workspace = ?,
            capability_version = ?, capability_verified_at = ?, capability_json = ?,
            capability_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(configuration.aliases),
        configuration.cli,
        configuration.nativeModel,
        configuration.reasoningEffort,
        enabled ? 1 : 0,
        configuration.isolationLevel,
        configuration.streamingMode,
        configuration.toolBridge,
        configuration.maxConcurrency,
        configuration.maxQueue,
        configuration.queueTimeoutMs,
        configuration.runTimeoutMs,
        configuration.fixedWorkspace,
        executionContractChanged ? null : current.capabilityVersion,
        executionContractChanged ? null : current.capabilityVerifiedAt,
        executionContractChanged ? null : (current.capabilities === null ? null : JSON.stringify(current.capabilities)),
        executionContractChanged ? 'configuration_changed' : current.capabilityError,
        now,
        id,
      );

      return this.getRequired(id);
    });

    return update();
  }

  get(idOrAlias: string): InvocationTarget | null {
    const row = this.findRow(idOrAlias);
    return row ? toInvocationTarget(row) : null;
  }

  list(): InvocationTarget[] {
    return this.db.prepare<[], InvocationTargetRow>(`
      SELECT ${TARGET_COLUMNS}
      FROM invocation_targets
      ORDER BY created_at DESC, rowid DESC
    `).all().map(toInvocationTarget);
  }

  delete(id: string): void {
    const remove = this.db.transaction(() => {
      const target = this.getRequired(id);
      if (target.enabled) throw new Error('target_enabled');
      const active = this.db.prepare<[string], { count: number }>(`
        SELECT COUNT(*) AS count FROM runs
        WHERE target_id = ? AND status IN ('queued', 'running')
      `).get(id);
      if ((active?.count ?? 0) > 0) throw new Error('target_in_use');
      const result = this.db.prepare('DELETE FROM invocation_targets WHERE id = ?').run(id);
      if (result.changes !== 1) throw new Error('target_not_found');
    });
    remove();
  }

  setCapability(id: string, input: CapabilityRecordInput): InvocationTarget {
    const current = this.getRequired(id);
    const capabilities = validateCapabilityRecord(input);
    this.db.prepare(`
      UPDATE invocation_targets
      SET capability_version = ?, capability_verified_at = ?, capability_json = ?,
          capability_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      input.version,
      input.verifiedAt,
      JSON.stringify(capabilities),
      nextTargetTimestamp(current.updatedAt),
      id,
    );

    return this.getRequired(id);
  }

  setCapabilityIfUnchanged(
    expected: InvocationTarget,
    input: CapabilityRecordInput,
  ): boolean {
    const capabilities = validateCapabilityRecord(input);
    const result = this.db.prepare(`
      UPDATE invocation_targets
      SET capability_version = ?, capability_verified_at = ?, capability_json = ?,
          capability_error = NULL, updated_at = ?
      WHERE id = ?
        AND cli = ?
        AND native_model = ?
        AND reasoning_effort IS ?
        AND isolation_level = ?
        AND streaming_mode = ?
        AND tool_bridge = ?
        AND fixed_workspace IS ?
        AND created_at = ?
        AND updated_at = ?
    `).run(
      input.version,
      input.verifiedAt,
      JSON.stringify(capabilities),
      nextTargetTimestamp(expected.updatedAt),
      expected.id,
      expected.cli,
      expected.nativeModel,
      expected.reasoningEffort,
      expected.isolationLevel,
      expected.streamingMode,
      expected.toolBridge,
      expected.fixedWorkspace,
      expected.createdAt,
      expected.updatedAt,
    );

    return result.changes === 1;
  }

  invalidateCapability(
    id: string,
    installedVersion: string | null,
    error: string,
    preserveVerifiedVersion = false,
  ): InvocationTarget {
    if (installedVersion !== null && typeof installedVersion !== 'string') {
      throw new Error('invalid_capability_version');
    }
    if (typeof error !== 'string' || error.length === 0) throw new Error('invalid_capability_error');

    const invalidate = this.db.transaction(() => {
      const current = this.getRequired(id);
      const capabilityVersion = preserveVerifiedVersion
        ? (current.capabilityVersion ?? installedVersion)
        : installedVersion;
      const result = this.db.prepare(`
        UPDATE invocation_targets
        SET enabled = 0, capability_version = ?, capability_verified_at = NULL,
            capability_json = NULL, capability_error = ?, updated_at = ?
        WHERE id = ?
      `).run(capabilityVersion, error, nextTargetTimestamp(current.updatedAt), id);
      if (result.changes !== 1) throw new Error('target_not_found');
      return this.getRequired(id);
    });

    return invalidate();
  }

  invalidateCapabilityIfUnchanged(
    expected: InvocationTarget,
    installedVersion: string | null,
    error: string,
    preserveVerifiedVersion = false,
  ): boolean {
    if (installedVersion !== null && typeof installedVersion !== 'string') {
      throw new Error('invalid_capability_version');
    }
    if (typeof error !== 'string' || error.length === 0) throw new Error('invalid_capability_error');

    const capabilityVersion = preserveVerifiedVersion
      ? (expected.capabilityVersion ?? installedVersion)
      : installedVersion;
    const result = this.db.prepare(`
      UPDATE invocation_targets
      SET enabled = 0, capability_version = ?, capability_verified_at = NULL,
          capability_json = NULL, capability_error = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).run(
      capabilityVersion,
      error,
      nextTargetTimestamp(expected.updatedAt),
      expected.id,
      expected.updatedAt,
    );

    return result.changes === 1;
  }

  private createConfiguration(input: CreateTargetInput): TargetConfiguration {
    if (!TARGET_ID.test(input.id)) throw new Error('invalid_target_id');
    const fixedWorkspace = normalizeFixedWorkspace(
      input.fixedWorkspace,
      input.acknowledgeFixedWorkspaceDowngrade,
    );
    return validateConfiguration({
      aliases: input.aliases ?? [],
      cli: input.cli,
      nativeModel: input.nativeModel,
      reasoningEffort: input.reasoningEffort ?? null,
      isolationLevel: fixedWorkspace === null ? (input.isolationLevel ?? 'strict') : 'best_effort',
      streamingMode: input.streamingMode ?? 'native',
      toolBridge: input.toolBridge ?? 'structured_output',
      maxConcurrency: input.maxConcurrency ?? 1,
      maxQueue: input.maxQueue ?? 8,
      queueTimeoutMs: input.queueTimeoutMs ?? 300_000,
      runTimeoutMs: input.runTimeoutMs ?? null,
      fixedWorkspace,
    }, input.id);
  }

  private updatedConfiguration(current: InvocationTarget, patch: UpdateTargetInput): TargetConfiguration {
    const fixedWorkspace = patch.fixedWorkspace === undefined
      ? current.fixedWorkspace
      : normalizeFixedWorkspace(patch.fixedWorkspace, patch.acknowledgeFixedWorkspaceDowngrade);
    return validateConfiguration({
      aliases: patch.aliases ?? current.aliases,
      cli: patch.cli ?? current.cli,
      nativeModel: patch.nativeModel ?? current.nativeModel,
      reasoningEffort: patch.reasoningEffort === undefined ? current.reasoningEffort : patch.reasoningEffort,
      isolationLevel: fixedWorkspace === null
        ? (patch.isolationLevel ?? current.isolationLevel)
        : 'best_effort',
      streamingMode: patch.streamingMode ?? current.streamingMode,
      toolBridge: patch.toolBridge ?? current.toolBridge,
      maxConcurrency: patch.maxConcurrency ?? current.maxConcurrency,
      maxQueue: patch.maxQueue ?? current.maxQueue,
      queueTimeoutMs: patch.queueTimeoutMs ?? current.queueTimeoutMs,
      runTimeoutMs: patch.runTimeoutMs === undefined ? current.runTimeoutMs : patch.runTimeoutMs,
      fixedWorkspace,
    }, current.id);
  }

  private getRequired(id: string): InvocationTarget {
    const row = this.db.prepare<[string], InvocationTargetRow>(`
      SELECT ${TARGET_COLUMNS} FROM invocation_targets WHERE id = ?
    `).get(id);
    if (!row) throw new Error('target_not_found');
    return toInvocationTarget(row);
  }

  private findRow(idOrAlias: string): InvocationTargetRow | undefined {
    return this.db.prepare<[string, string], InvocationTargetRow>(`
      SELECT ${TARGET_COLUMNS}
      FROM invocation_targets
      WHERE id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END)
           WHERE value = ?
         )
      LIMIT 1
    `).get(idOrAlias, idOrAlias);
  }

  private assertIdentifiersAvailable(id: string, aliases: string[], excludeId?: string): void {
    const identifiers = [id, ...aliases];
    for (const identifier of identifiers) {
      const row = excludeId === undefined
        ? this.db.prepare<[string, string], Pick<InvocationTargetRow, 'id'>>(`
            SELECT id
            FROM invocation_targets
            WHERE id = ?
               OR EXISTS (
                 SELECT 1
                 FROM json_each(CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END)
                 WHERE value = ?
               )
            LIMIT 1
          `).get(identifier, identifier)
        : this.db.prepare<[string, string, string], Pick<InvocationTargetRow, 'id'>>(`
            SELECT id
            FROM invocation_targets
            WHERE id <> ?
              AND (
                id = ?
                OR EXISTS (
                  SELECT 1
                  FROM json_each(CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END)
                  WHERE value = ?
                )
              )
            LIMIT 1
          `).get(excludeId, identifier, identifier);
      if (row) throw new Error('target_id_exists');
    }
  }
}

const TARGET_COLUMNS = `
  id, aliases_json, cli, native_model, reasoning_effort, enabled, isolation_level,
  streaming_mode, tool_bridge, max_concurrency, max_queue, queue_timeout_ms,
  run_timeout_ms, fixed_workspace, capability_version, capability_verified_at,
  capability_json, capability_error, created_at, updated_at
`;

function validateConfiguration(configuration: TargetConfiguration, id: string): TargetConfiguration {
  const aliases = validateAliases(configuration.aliases, id);
  if (typeof configuration.cli !== 'string' || configuration.cli.trim().length === 0) {
    throw new Error('invalid_target_cli');
  }
  if (typeof configuration.nativeModel !== 'string' || configuration.nativeModel.trim().length === 0) {
    throw new Error('invalid_native_model');
  }
  if (configuration.reasoningEffort !== null
    && (typeof configuration.reasoningEffort !== 'string' || configuration.reasoningEffort.trim().length === 0)) {
    throw new Error('invalid_reasoning_effort');
  }
  if (configuration.isolationLevel !== 'strict' && configuration.isolationLevel !== 'best_effort') {
    throw new Error('invalid_isolation_level');
  }
  if (configuration.streamingMode !== 'native' && configuration.streamingMode !== 'none') {
    throw new Error('invalid_streaming_mode');
  }
  if (configuration.toolBridge !== 'structured_output' && configuration.toolBridge !== 'none') {
    throw new Error('invalid_tool_bridge');
  }
  if (!isPositiveInteger(configuration.maxConcurrency)) throw new Error('invalid_max_concurrency');
  if (!Number.isInteger(configuration.maxQueue) || configuration.maxQueue < 0) throw new Error('invalid_max_queue');
  if (!isPositiveInteger(configuration.queueTimeoutMs)) throw new Error('invalid_queue_timeout');
  if (configuration.runTimeoutMs !== null && !isPositiveInteger(configuration.runTimeoutMs)) {
    throw new Error('invalid_run_timeout');
  }

  return { ...configuration, aliases };
}

function validateAliases(aliases: string[], id: string): string[] {
  if (!Array.isArray(aliases)) throw new Error('invalid_target_alias');
  const seen = new Set<string>([id]);
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias.trim().length === 0) throw new Error('invalid_target_alias');
    if (seen.has(alias)) throw new Error('target_id_exists');
    seen.add(alias);
  }
  return [...aliases];
}

function normalizeFixedWorkspace(
  fixedWorkspace: string | null | undefined,
  acknowledged: boolean | undefined,
): string | null {
  if (fixedWorkspace === undefined || fixedWorkspace === null) return null;
  fixedWorkspace = fixedWorkspace.trim();
  if (fixedWorkspace.length === 0) throw new Error('fixed_workspace_required_for_best_effort');
  if (acknowledged !== true) throw new Error('fixed_workspace_acknowledgement_required');
  if (!isAbsolute(fixedWorkspace)) throw new Error('fixed_workspace_must_be_absolute');
  try {
    return realpathSync(fixedWorkspace);
  } catch {
    throw new Error('fixed_workspace_not_found');
  }
}

function hasExecutionContractChanged(
  current: InvocationTarget,
  next: TargetConfiguration,
): boolean {
  return current.cli !== next.cli
    || current.nativeModel !== next.nativeModel
    || current.reasoningEffort !== next.reasoningEffort
    || current.isolationLevel !== next.isolationLevel
    || current.streamingMode !== next.streamingMode
    || current.toolBridge !== next.toolBridge
    || current.fixedWorkspace !== next.fixedWorkspace;
}

function parseAliases(value: string): string[] {
  try {
    const aliases: unknown = JSON.parse(value);
    return Array.isArray(aliases) && aliases.every((alias) => typeof alias === 'string') ? aliases : [];
  } catch {
    return [];
  }
}

function parseCapabilities(value: string | null): TargetCapabilities | null {
  if (value === null) return null;
  try {
    const capabilities: unknown = JSON.parse(value);
    return isTargetCapabilities(capabilities) ? canonicalCapabilities(capabilities) : null;
  } catch {
    return null;
  }
}

function isTargetCapabilities(value: unknown): value is TargetCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Partial<TargetCapabilities>;
  return (capabilities.isolationLevel === 'strict' || capabilities.isolationLevel === 'best_effort')
    && (capabilities.streamingMode === 'native' || capabilities.streamingMode === 'none')
    && (capabilities.toolBridge === 'structured_output' || capabilities.toolBridge === 'none')
    && typeof capabilities.resume === 'boolean'
    && typeof capabilities.cancellation === 'boolean'
    && typeof capabilities.modelSelection === 'boolean'
    && typeof capabilities.effortSelection === 'boolean'
    && (capabilities.details === undefined
      || (Array.isArray(capabilities.details)
        && capabilities.details.every((detail) => typeof detail === 'string')));
}

function canonicalCapabilities(capabilities: TargetCapabilities): TargetCapabilities {
  return {
    isolationLevel: capabilities.isolationLevel,
    streamingMode: capabilities.streamingMode,
    toolBridge: capabilities.toolBridge,
    resume: capabilities.resume,
    cancellation: capabilities.cancellation,
    modelSelection: capabilities.modelSelection,
    effortSelection: capabilities.effortSelection,
    ...(capabilities.details === undefined ? {} : { details: [...capabilities.details] }),
  };
}

function validateCapabilityRecord(input: CapabilityRecordInput): TargetCapabilities {
  if (typeof input.version !== 'string' || input.version.length === 0
    || !isUtcIsoTimestamp(input.verifiedAt)
    || !isTargetCapabilities(input.capabilities)) {
    throw new Error('invalid_capability');
  }
  return canonicalCapabilities(input.capabilities);
}

function nextTargetTimestamp(after?: string): string {
  const afterMs = after === undefined ? 0 : Date.parse(after);
  const timestamp = Math.max(
    Date.now(),
    lastTargetTimestampMs + 1,
    Number.isFinite(afterMs) ? afterMs + 1 : 0,
  );
  lastTargetTimestampMs = timestamp;
  return new Date(timestamp).toISOString();
}

function isUtcIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function supportsIsolation(required: IsolationLevel, actual: IsolationLevel): boolean {
  return required === 'best_effort' || actual === 'strict';
}

function supportsStreaming(required: StreamingMode, actual: StreamingMode): boolean {
  return required === 'none' || actual === 'native';
}

function supportsToolBridge(required: ToolBridge, actual: ToolBridge): boolean {
  return required === 'none' || actual === 'structured_output';
}
