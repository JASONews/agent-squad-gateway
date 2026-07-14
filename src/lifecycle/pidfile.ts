import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GatewayPaths } from '../config/paths.js';

export function readPid(paths: Pick<GatewayPaths, 'pidPath'>): number | null {
  const result = inspectPid(paths);
  return result.kind === 'valid' ? result.pid : null;
}

export type PidFileResult =
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'valid'; pid: number };

export function inspectPid(paths: Pick<GatewayPaths, 'pidPath'>): PidFileResult {
  if (!existsSync(paths.pidPath)) return { kind: 'missing' };
  const content = readFileSync(paths.pidPath, 'utf8').trim();
  if (!/^\d+$/.test(content)) return { kind: 'malformed' };
  const pid = Number(content);
  return Number.isSafeInteger(pid) && pid > 0
    ? { kind: 'valid', pid }
    : { kind: 'malformed' };
}

export function writePid(paths: Pick<GatewayPaths, 'pidPath'>, pid: number): void {
  mkdirSync(dirname(paths.pidPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.pidPath, String(pid), { mode: 0o600 });
}

export function removePid(paths: Pick<GatewayPaths, 'pidPath'>): void {
  try {
    unlinkSync(paths.pidPath);
  } catch (error) {
    if (!isErrorWithCode(error, 'ENOENT')) throw error;
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
