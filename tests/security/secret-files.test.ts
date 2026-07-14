import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecretFile, readSecretFile } from '../../src/security/secret-files.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('secret files', () => {
  it('creates and reuses a 0600 secret', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-secret-')); dirs.push(dir);
    const path = join(dir, 'master.key');
    const first = ensureSecretFile(path, 32);
    const second = ensureSecretFile(path, 32);
    expect(second.equals(first)).toBe(true);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(readSecretFile(path).length).toBe(32);
  });

  it('tightens an existing parent directory to 0700', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-secret-')); dirs.push(dir);
    fs.chmodSync(dir, 0o755);

    ensureSecretFile(join(dir, 'master.key'), 32);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('rejects an existing secret with the wrong length', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-secret-')); dirs.push(dir);
    const path = join(dir, 'master.key');
    fs.writeFileSync(path, Buffer.alloc(16), { mode: 0o600 });

    expect(() => ensureSecretFile(path, 32)).toThrow(`invalid secret length at ${path}`);
  });

  it('reuses the winner when exclusive creation loses with EEXIST', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-secret-')); dirs.push(dir);
    const path = join(dir, 'master.key');
    const winner = Buffer.alloc(32, 9);
    const raceFileSystem = {
      mkdirSync: fs.mkdirSync,
      chmodSync: fs.chmodSync,
      readFileSync: fs.readFileSync,
      writeFileSync: () => {
        fs.writeFileSync(path, winner, { mode: 0o600 });
        throw Object.assign(new Error('exclusive create lost'), { code: 'EEXIST' });
      },
    };

    const value = ensureSecretFile(path, 32, raceFileSystem);

    expect(value.equals(winner)).toBe(true);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it('propagates non-EEXIST exclusive-create errors', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-secret-')); dirs.push(dir);
    const path = join(dir, 'master.key');
    const fileSystem = {
      mkdirSync: fs.mkdirSync,
      chmodSync: fs.chmodSync,
      readFileSync: fs.readFileSync,
      writeFileSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };

    expect(() => ensureSecretFile(path, 32, fileSystem)).toThrow('permission denied');
  });
});
