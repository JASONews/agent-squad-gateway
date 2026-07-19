import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installProviderSearchPath,
  providerBinDirectories,
  resolveProviderCommand,
} from '../../src/provider-runtime/command-discovery.js';
import { BUILT_IN_PROVIDER_COMMANDS } from '../../src/provider-runtime/register-providers.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('provider command discovery', () => {
  it('finds npm-installed provider CLIs in user and prefix bin directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'asq-provider-path-'));
    directories.push(root);
    const home = join(root, 'home');
    const existingBin = join(root, 'existing-bin');
    const localBin = join(home, '.local', 'bin');
    const npmPrefix = join(root, 'npm-prefix');
    const prefixBin = join(npmPrefix, 'bin');
    const codex = executable(join(localBin, 'codex'));
    const agy = executable(join(prefixBin, 'agy'));
    mkdirSync(existingBin, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: existingBin,
      HOME: home,
      npm_config_prefix: npmPrefix,
    };

    const installedPath = installProviderSearchPath(env, {
      homeDir: home,
      execPath: join(root, 'missing-runtime', 'node'),
    });

    expect(installedPath.split(':')[0]).toBe(existingBin);
    expect(installedPath.split(':')).toEqual(expect.arrayContaining([localBin, prefixBin]));
    expect(resolveProviderCommand('codex', { env, homeDir: home })).toBe(codex);
    expect(resolveProviderCommand('agy', { env, homeDir: home })).toBe(agy);
  });

  it('discovers Node version-manager bins without replacing the existing PATH order', () => {
    const root = mkdtempSync(join(tmpdir(), 'asq-provider-manager-path-'));
    directories.push(root);
    const home = join(root, 'home');
    const currentPath = join(root, 'current-bin');
    const asdfBin = join(home, '.asdf', 'installs', 'nodejs', '24.5.0', 'bin');
    mkdirSync(currentPath, { recursive: true });
    executable(join(asdfBin, 'codex'));
    const env = { PATH: currentPath, HOME: home };

    expect(providerBinDirectories({ env, homeDir: home, execPath: join(currentPath, 'node') }))
      .toEqual([currentPath, asdfBin]);
  });

  it('uses agy as the Antigravity executable', () => {
    expect(BUILT_IN_PROVIDER_COMMANDS.antigravity).toBe('agy');
  });

  it('uses cursor-agent as the Cursor executable', () => {
    expect(BUILT_IN_PROVIDER_COMMANDS.cursor).toBe('cursor-agent');
  });

  it('uses kimi as the Kimi Code executable', () => {
    expect(BUILT_IN_PROVIDER_COMMANDS.kimi).toBe('kimi');
  });
});

function executable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}
