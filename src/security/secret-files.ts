import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

interface SecretFileSystem {
  mkdirSync: typeof mkdirSync;
  chmodSync: typeof chmodSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
}

const defaultFileSystem: SecretFileSystem = {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
};

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function ensureSecretFile(
  path: string,
  bytes: number,
  fileSystem: SecretFileSystem = defaultFileSystem,
): Buffer {
  const parent = dirname(path);
  fileSystem.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync(parent, 0o700);

  try {
    fileSystem.writeFileSync(path, randomBytes(bytes), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!isErrorWithCode(error, 'EEXIST')) throw error;
  }

  fileSystem.chmodSync(path, 0o600);
  const value = fileSystem.readFileSync(path);
  if (value.length !== bytes) throw new Error(`invalid secret length at ${path}`);
  return value;
}

export function readSecretFile(path: string): Buffer {
  return readFileSync(path);
}
