import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

export interface ProviderCommandDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function providerBinDirectories(
  options: ProviderCommandDiscoveryOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? ';' : ':';
  const home = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const directories: string[] = [];
  const seen = new Set<string>();
  const add = (directory: string | undefined, requireDirectory: boolean): void => {
    if (!directory) return;
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (seen.has(key) || (requireDirectory && !isDirectory(directory))) return;
    seen.add(key);
    directories.push(directory);
  };

  for (const directory of (env.PATH ?? '').split(separator)) add(directory, false);

  add(dirname(options.execPath ?? process.execPath), true);
  add(prefixBin(env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX, platform), true);
  add(env.NVM_BIN, true);
  add(env.PNPM_HOME, true);
  add(env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : undefined, true);
  add(env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin') : undefined, true);

  const asdfData = env.ASDF_DATA_DIR ?? join(home, '.asdf');
  const commonDirectories = [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(asdfData, 'shims'),
    join(home, '.mise', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
  ];
  for (const directory of commonDirectories) add(directory, true);

  addVersionedBins(join(home, '.nvm', 'versions', 'node'), ['bin'], add);
  addVersionedBins(join(asdfData, 'installs', 'nodejs'), ['bin'], add);
  addVersionedBins(join(home, '.fnm', 'node-versions'), ['installation', 'bin'], add);
  addVersionedBins(
    join(home, '.local', 'share', 'fnm', 'node-versions'),
    ['installation', 'bin'],
    add,
  );
  addVersionedBins(join(home, '.local', 'share', 'mise', 'installs', 'node'), ['bin'], add);

  return directories;
}

export function installProviderSearchPath(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<ProviderCommandDiscoveryOptions, 'env'> = {},
): string {
  const platform = options.platform ?? process.platform;
  const value = providerBinDirectories({ ...options, env }).join(platform === 'win32' ? ';' : ':');
  env.PATH = value;
  return value;
}

export function resolveProviderCommand(
  command: string,
  options: ProviderCommandDiscoveryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const names = commandNames(command, env, platform);
  const candidates = isAbsolute(command)
    ? names
    : providerBinDirectories({ ...options, env }).flatMap((directory) =>
      names.map((name) => resolve(directory, name)));
  const accessMode = platform === 'win32' ? constants.F_OK : constants.X_OK;

  for (const candidate of candidates) {
    try {
      accessSync(candidate, accessMode);
      return candidate;
    } catch {
      // Continue through the deterministic provider search path.
    }
  }
  return null;
}

function prefixBin(prefix: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (!prefix) return undefined;
  return platform === 'win32' ? prefix : join(prefix, 'bin');
}

function commandNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32' || extname(command)) return [command];
  return (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function addVersionedBins(
  root: string,
  suffix: string[],
  add: (directory: string, requireDirectory: boolean) => void,
): void {
  let versions: string[];
  try {
    versions = readdirSync(root).sort().reverse();
  } catch {
    return;
  }
  for (const version of versions) add(join(root, version, ...suffix), true);
}
