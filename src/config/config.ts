import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';
import type {
  ModelCapabilityDetails,
  ModelCapabilityProfile,
  ModelProfileCatalog,
  ModelProfileCatalogByCli,
} from '../provider-runtime/types.js';
import { resolveGatewayPaths, type GatewayPaths } from './paths.js';

export const GATEWAY_BIND_HOST = '0.0.0.0' as const;
export const GATEWAY_LOOPBACK_HOST = '127.0.0.1' as const;
export type GatewayWebUiAuthMode = 'disabled' | 'token';

const HOSTNAME_PATTERN = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const gatewayAddressSchema = z.string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => isIP(value) !== 0 || HOSTNAME_PATTERN.test(value), 'invalid address')
  .transform((value) => value.toLowerCase());

const modelCapabilityDetailsSchema = z.object({
  summary: z.string().min(1).optional(),
  strengths: z.array(z.string().min(1)).optional(),
  weaknesses: z.array(z.string().min(1)).optional(),
  recommended_for: z.array(z.string().min(1)).optional(),
  avoid_for: z.array(z.string().min(1)).optional(),
  cost_tier: z.enum(['low', 'medium', 'high', 'unknown']).optional(),
  latency_tier: z.enum(['fast', 'medium', 'slow', 'unknown']).optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).strict();

const modelCapabilityProfileSchema = modelCapabilityDetailsSchema.extend({
  effort_profiles: z.record(z.string().min(1), modelCapabilityDetailsSchema).optional(),
}).strict();

const modelProfileCatalogSchema = z.record(
  z.string().min(1),
  modelCapabilityProfileSchema,
);

const modelProfilesByCliSchema = z.record(
  z.string().min(1),
  modelProfileCatalogSchema,
).default({});

const gatewayConfigFileSchema = z.object({
  address: gatewayAddressSchema,
  port: z.number().int().min(1).max(65_535),
  web_ui_auth: z.enum(['disabled', 'token']),
  model_profiles: modelProfilesByCliSchema,
}).strict();

const runtimeGatewayConfigSchema = gatewayConfigFileSchema.extend({
  port: z.number().int().min(0).max(65_535),
});

type GatewayConfigFile = z.infer<typeof gatewayConfigFileSchema>;

const DEFAULT_GATEWAY_CONFIG_FILE: GatewayConfigFile = {
  address: GATEWAY_BIND_HOST,
  port: 28_772,
  web_ui_auth: 'disabled',
  model_profiles: {},
};

export interface GatewayConfigInput {
  baseDir?: string;
  address?: string;
  port?: number;
  coreUrl?: string;
  webUiAuth?: GatewayWebUiAuthMode;
  modelProfiles?: ModelProfileCatalogByCli;
}

export interface GatewayConfig {
  host: string;
  port: number;
  coreUrl: string;
  webUiAuth: GatewayWebUiAuthMode;
  modelProfiles: ModelProfileCatalogByCli;
  paths: GatewayPaths;
}

export function resolveGatewayConfig(input: GatewayConfigInput = {}): GatewayConfig {
  const fileConfig = parseRuntimeConfig({
    address: input.address ?? DEFAULT_GATEWAY_CONFIG_FILE.address,
    port: input.port ?? DEFAULT_GATEWAY_CONFIG_FILE.port,
    web_ui_auth: input.webUiAuth ?? DEFAULT_GATEWAY_CONFIG_FILE.web_ui_auth,
  }, 'Gateway configuration');
  return {
    host: fileConfig.address,
    port: fileConfig.port,
    coreUrl: (input.coreUrl ?? 'http://127.0.0.1:28771').replace(/\/$/, ''),
    webUiAuth: fileConfig.web_ui_auth,
    modelProfiles: input.modelProfiles ?? {},
    paths: resolveGatewayPaths(input.baseDir),
  };
}

export function loadGatewayConfig(input: GatewayConfigInput = {}): GatewayConfig {
  const paths = resolveGatewayPaths(input.baseDir);
  const fileConfig = readGatewayConfigFile(paths.configPath) ?? DEFAULT_GATEWAY_CONFIG_FILE;
  const mergedConfig = parseConfigFile({
    address: input.address ?? fileConfig.address,
    port: input.port ?? fileConfig.port,
    web_ui_auth: input.webUiAuth ?? fileConfig.web_ui_auth,
    model_profiles: fileConfig.model_profiles,
  }, 'Gateway configuration');
  return resolveGatewayConfig({
    ...input,
    address: mergedConfig.address,
    port: mergedConfig.port,
    webUiAuth: mergedConfig.web_ui_auth,
    modelProfiles: input.modelProfiles
      ?? resolveModelProfileCatalogByCli(mergedConfig.model_profiles),
  });
}

export function ensureGatewayConfigFile(baseDir?: string): string {
  const paths = resolveGatewayPaths(baseDir);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      paths.configPath,
      `${JSON.stringify(DEFAULT_GATEWAY_CONFIG_FILE, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }
  return paths.configPath;
}

export function gatewayLoopbackOrigin(config: Pick<GatewayConfig, 'host' | 'port'>): string {
  const host = config.host === GATEWAY_BIND_HOST
    ? GATEWAY_LOOPBACK_HOST
    : config.host === '::'
      ? '::1'
      : config.host;
  return `http://${formatGatewayAddress(host, config.port)}`;
}

export function formatGatewayAddress(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function gatewayBindPolicy(host: string): 'all-interfaces' | 'loopback' | 'configured-address' {
  if (host === '0.0.0.0' || host === '::') return 'all-interfaces';
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return 'loopback';
  return 'configured-address';
}

function readGatewayConfigFile(path: string): GatewayConfigFile | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }

  try {
    return parseConfigFile(JSON.parse(content), `Gateway config file ${path}`);
  } catch (error) {
    throw new Error(`invalid Gateway config file: ${path}`, { cause: error });
  }
}

function parseConfigFile(value: unknown, label: string): GatewayConfigFile {
  const result = gatewayConfigFileSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid ${label}`, { cause: result.error });
  return result.data;
}

function parseRuntimeConfig(value: unknown, label: string): GatewayConfigFile {
  const result = runtimeGatewayConfigSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid ${label}`, { cause: result.error });
  return result.data;
}

type RawModelCapabilityDetails = z.infer<typeof modelCapabilityDetailsSchema>;
type RawModelCapabilityProfile = z.infer<typeof modelCapabilityProfileSchema>;

function resolveModelCapabilityDetails(
  raw: RawModelCapabilityDetails,
): ModelCapabilityDetails {
  return {
    ...(raw.summary === undefined ? {} : { summary: raw.summary }),
    ...(raw.strengths === undefined ? {} : { strengths: [...raw.strengths] }),
    ...(raw.weaknesses === undefined ? {} : { weaknesses: [...raw.weaknesses] }),
    ...(raw.recommended_for === undefined
      ? {}
      : { recommendedFor: [...raw.recommended_for] }),
    ...(raw.avoid_for === undefined ? {} : { avoidFor: [...raw.avoid_for] }),
    ...(raw.cost_tier === undefined ? {} : { costTier: raw.cost_tier }),
    ...(raw.latency_tier === undefined ? {} : { latencyTier: raw.latency_tier }),
    ...(raw.priority === undefined ? {} : { priority: raw.priority }),
  };
}

function resolveModelCapabilityProfile(
  raw: RawModelCapabilityProfile,
): ModelCapabilityProfile {
  const effortProfiles = raw.effort_profiles === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(raw.effort_profiles).map(([effort, details]) => [
          effort,
          resolveModelCapabilityDetails(details),
        ]),
      );
  return {
    ...resolveModelCapabilityDetails(raw),
    ...(effortProfiles === undefined ? {} : { effortProfiles }),
  };
}

function resolveModelProfileCatalogByCli(
  raw: Record<string, Record<string, RawModelCapabilityProfile>>,
): ModelProfileCatalogByCli {
  return Object.fromEntries(
    Object.entries(raw).map(([cli, catalog]) => [
      cli,
      Object.fromEntries(
        Object.entries(catalog).map(([pattern, profile]) => [
          pattern,
          resolveModelCapabilityProfile(profile),
        ]),
      ) satisfies ModelProfileCatalog,
    ]),
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
