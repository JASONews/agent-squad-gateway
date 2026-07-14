import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGatewayConfig } from '../../../src/config/config.js';
import { ClientRepository } from '../../../src/control-plane/clients.js';
import { CredentialService } from '../../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../../src/control-plane/db.js';
import { ExtensionRepository } from '../../../src/control-plane/extensions.js';
import { GrantRepository } from '../../../src/control-plane/grants.js';
import { RunRepository } from '../../../src/control-plane/runs.js';
import { TargetRepository } from '../../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../../src/control-plane/types.js';
import { AdminAuthService } from '../../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../../src/server/app.js';

const OPENAI_ERROR_KEYS = ['code', 'message', 'param', 'type'];
const VERIFIED_CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

let app: FastifyInstance;
let db: GatewayDb;
let clients: ClientRepository;
let credentials: CredentialService;
let extensions: ExtensionRepository;
let grants: GrantRepository;
let targets: TargetRepository;

function createEnabledTarget(id: string, aliases: string[]): InvocationTarget {
  const target = targets.create({
    id,
    aliases,
    cli: 'codex',
    nativeModel: 'gpt-5.6',
    reasoningEffort: 'max',
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 300_000,
    runTimeoutMs: null,
  });
  targets.setCapability(id, {
    version: '1.0.0',
    verifiedAt: '2026-07-10T12:00:00.000Z',
    capabilities: VERIFIED_CAPABILITIES,
  });
  return targets.update(id, { enabled: true });
}

function expectOpenAIError(response: { statusCode: number; json: () => unknown }, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  const body = response.json() as { error: Record<string, unknown> };
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(OPENAI_ERROR_KEYS);
  expect(body.error).toMatchObject({
    message: expect.any(String),
    type: expect.any(String),
    param: null,
    code,
  });
}

beforeEach(async () => {
  db = openGatewayDb(':memory:');
  clients = new ClientRepository(db);
  credentials = new CredentialService(db, Buffer.alloc(32, 5));
  extensions = new ExtensionRepository(db);
  grants = new GrantRepository(db);
  targets = new TargetRepository(db);
  app = buildGatewayApp({
    config: resolveGatewayConfig({ baseDir: '/tmp/asq-gateway-models-test' }),
    db,
    clients,
    credentials,
    extensions,
    grants,
    targets,
    runs: new RunRepository(db),
    adminAuth: new AdminAuthService(db, Buffer.alloc(32, 7)),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('GET /v1/models', () => {
  it('accepts exactly an Authorization Bearer credential', async () => {
    const client = clients.create('auth-client');
    const credential = credentials.create(client.id, 'primary');
    extensions.upsert('openai', '1.0.0', true);

    const cases = [
      undefined,
      credential.apiKey,
      `bearer ${credential.apiKey}`,
      `Bearer  ${credential.apiKey}`,
      `Bearer ${credential.apiKey} trailing`,
    ];
    for (const authorization of cases) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: authorization === undefined ? {} : { authorization },
      });
      expectOpenAIError(response, 401, 'invalid_api_key');
    }
  });

  it('rejects unknown, revoked, and expired credentials', async () => {
    const client = clients.create('credential-state-client');
    extensions.upsert('openai', '1.0.0', true);
    const revoked = credentials.create(client.id, 'revoked');
    credentials.revoke(revoked.id);
    const expired = credentials.create(client.id, 'expired');
    db.prepare('UPDATE credentials SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', expired.id);

    const unknown = `asqsk_${'0'.repeat(18)}_${'a'.repeat(43)}`;
    for (const apiKey of [unknown, revoked.apiKey, expired.apiKey]) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expectOpenAIError(response, 401, 'invalid_api_key');
    }
  });

  it('rejects a valid unexpired credential when its client is disabled', async () => {
    const client = clients.create('disabled-client');
    const credential = credentials.create(client.id, 'valid-primary');
    extensions.upsert('openai', '1.0.0', true);
    clients.setStatus(client.id, 'disabled');

    const response = await app.inject({
      method: 'GET', url: '/v1/models',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });

    expectOpenAIError(response, 401, 'invalid_api_key');
  });

  it('returns an OpenAI 403 error when the compiled extension is disabled', async () => {
    const client = clients.create('disabled-extension-client');
    const credential = credentials.create(client.id, 'primary');
    extensions.upsert('openai', '1.0.0', false);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });

    expectOpenAIError(response, 403, 'extension_disabled');
  });

  it('omits ungranted, disabled, and capability-incompatible targets', async () => {
    const client = clients.create('filtered-model-client');
    const credential = credentials.create(client.id, 'primary');
    extensions.upsert('openai', '1.0.0', true);
    createEnabledTarget('ungranted-model', ['ungranted-alias']);
    const disabled = createEnabledTarget('disabled-model', ['disabled-alias']);
    grants.grant(client.id, 'openai', disabled.id);
    targets.update(disabled.id, { enabled: false });
    const incompatible = createEnabledTarget('incompatible-model', ['incompatible-alias']);
    grants.grant(client.id, 'openai', incompatible.id);
    db.prepare('UPDATE invocation_targets SET capability_verified_at = NULL WHERE id = ?')
      .run(incompatible.id);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ object: 'list', data: [] });
  });

  it('lists granted canonical IDs and aliases once in deterministic order with exact model fields', async () => {
    const client = clients.create('models-client');
    const credential = credentials.create(client.id, 'primary');
    extensions.upsert('openai', '1.0.0', true);
    const target = createEnabledTarget('codex-gpt56-max', ['z-model-alias', 'a-model-alias']);
    grants.grant(client.id, 'openai', target.id);
    db.prepare('UPDATE invocation_targets SET aliases_json = ? WHERE id = ?')
      .run(JSON.stringify(['z-model-alias', 'a-model-alias', 'a-model-alias']), target.id);
    const created = Math.floor(Date.parse(target.createdAt) / 1000);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: 'list',
      data: ['a-model-alias', 'codex-gpt56-max', 'z-model-alias'].map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'agent-squad-gateway',
      })),
    });
  });

  it('updates model visibility immediately after grant creation and revocation', async () => {
    const client = clients.create('grant-lifecycle-client');
    const credential = credentials.create(client.id, 'primary');
    extensions.upsert('openai', '1.0.0', true);
    const target = createEnabledTarget('grant-lifecycle-model', ['grant-lifecycle-alias']);
    const listModels = () => app.inject({
      method: 'GET', url: '/v1/models',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });

    expect((await listModels()).json()).toEqual({ object: 'list', data: [] });
    grants.grant(client.id, 'openai', target.id);
    expect((await listModels()).json()).toMatchObject({
      data: [
        { id: 'grant-lifecycle-alias' },
        { id: 'grant-lifecycle-model' },
      ],
    });
    grants.revoke(client.id, 'openai', target.id);
    expect((await listModels()).json()).toEqual({ object: 'list', data: [] });
  });

  it('uses the OpenAI error envelope for unknown /v1 routes', async () => {
    const client = clients.create('not-found-client');
    const credential = credentials.create(client.id, 'primary');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/not-a-route',
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });
    expectOpenAIError(response, 404, 'not_found');
  });
});
