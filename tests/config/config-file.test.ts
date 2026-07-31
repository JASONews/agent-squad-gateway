import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureGatewayConfigFile,
  loadGatewayConfig,
} from '../../src/config/config.js';
import { resolveGatewayPaths } from '../../src/config/paths.js';

const dirs: string[] = [];

function temporaryBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asq-gateway-config-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(baseDir: string, value: unknown): void {
  const paths = resolveGatewayPaths(baseDir);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify(value)}\n`);
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('Gateway config file', () => {
  it('creates a private default config once', () => {
    const baseDir = temporaryBaseDir();
    const path = ensureGatewayConfigFile(baseDir);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      address: '0.0.0.0',
      port: 28_772,
      web_ui_auth: 'disabled',
      model_profiles: {},
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, '{"address":"127.0.0.1","port":30000,"web_ui_auth":"token"}\n');
    ensureGatewayConfigFile(baseDir);
    expect(loadGatewayConfig({ baseDir })).toMatchObject({
      host: '127.0.0.1',
      port: 30_000,
      webUiAuth: 'token',
    });
  });

  it('uses defaults without creating a file outside the start flow', () => {
    const baseDir = temporaryBaseDir();
    const paths = resolveGatewayPaths(baseDir);

    expect(loadGatewayConfig({ baseDir })).toMatchObject({
      host: '0.0.0.0',
      port: 28_772,
      webUiAuth: 'disabled',
    });
    expect(existsSync(paths.configPath)).toBe(false);
  });

  it('loads file values and lets explicit options override them', () => {
    const baseDir = temporaryBaseDir();
    writeConfig(baseDir, {
      address: '127.0.0.1',
      port: 30_000,
      web_ui_auth: 'token',
    });

    expect(loadGatewayConfig({ baseDir })).toMatchObject({
      host: '127.0.0.1',
      port: 30_000,
      webUiAuth: 'token',
    });
    expect(loadGatewayConfig({
      baseDir,
      address: '::1',
      port: 31_000,
      webUiAuth: 'disabled',
    })).toMatchObject({
      host: '::1',
      port: 31_000,
      webUiAuth: 'disabled',
    });
    expect(() => loadGatewayConfig({ baseDir, port: 0 })).toThrow('invalid Gateway configuration');
  });

  it('loads model profile overrides without changing their replacement semantics', () => {
    const baseDir = temporaryBaseDir();
    writeConfig(baseDir, {
      address: '127.0.0.1',
      port: 28_772,
      web_ui_auth: 'disabled',
      model_profiles: {
        codex: {
          'gpt-5.6-luna': {
            strengths: ['Local repository work'],
            weaknesses: [],
            recommended_for: ['routine_implementation'],
            cost_tier: 'low',
            priority: 96,
            effort_profiles: {
              max: {
                latency_tier: 'medium',
                priority: 98,
              },
            },
          },
        },
      },
    });

    expect(loadGatewayConfig({ baseDir }).modelProfiles).toEqual({
      codex: {
        'gpt-5.6-luna': {
          strengths: ['Local repository work'],
          weaknesses: [],
          recommendedFor: ['routine_implementation'],
          costTier: 'low',
          priority: 96,
          effortProfiles: {
            max: {
              latencyTier: 'medium',
              priority: 98,
            },
          },
        },
      },
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['unknown fields', '{"address":"127.0.0.1","port":28772,"web_ui_auth":"disabled","token":"do-not-log"}'],
    ['invalid address', '{"address":"http://127.0.0.1","port":28772,"web_ui_auth":"disabled"}'],
    ['address with a port', '{"address":"127.0.0.1:30000","port":28772,"web_ui_auth":"disabled"}'],
    ['invalid port', '{"address":"127.0.0.1","port":0,"web_ui_auth":"disabled"}'],
    ['invalid auth mode', '{"address":"127.0.0.1","port":28772,"web_ui_auth":"sometimes"}'],
    ['invalid model profile', '{"address":"127.0.0.1","port":28772,"web_ui_auth":"disabled","model_profiles":{"codex":{"*":{"cost_tier":"free"}}}}'],
  ])('rejects %s without echoing file contents', (_label, content) => {
    const baseDir = temporaryBaseDir();
    const paths = resolveGatewayPaths(baseDir);
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.configPath, content);

    expect(() => loadGatewayConfig({ baseDir })).toThrow(`invalid Gateway config file: ${paths.configPath}`);
    try {
      loadGatewayConfig({ baseDir });
    } catch (error) {
      expect((error as Error).message).not.toContain('do-not-log');
    }
  });
});
