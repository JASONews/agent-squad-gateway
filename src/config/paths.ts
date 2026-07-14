import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GatewayPaths {
  stateDir: string;
  configPath: string;
  dbPath: string;
  pidPath: string;
  logPath: string;
  masterKeyPath: string;
  adminSecretPath: string;
  workspacesDir: string;
}

export function resolveGatewayPaths(baseDir = homedir()): GatewayPaths {
  const stateDir = join(baseDir, '.agent-squad', 'gateway');
  return {
    stateDir,
    configPath: join(stateDir, 'config.json'),
    dbPath: join(stateDir, 'gateway.db'),
    pidPath: join(stateDir, 'gateway.pid'),
    logPath: join(stateDir, 'gateway.log'),
    masterKeyPath: join(stateDir, 'master.key'),
    adminSecretPath: join(stateDir, 'admin-secret'),
    workspacesDir: join(stateDir, 'workspaces'),
  };
}
