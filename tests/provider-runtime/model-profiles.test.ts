import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_GATEWAY_MODEL_PROFILE_CATALOG_VERSION,
  resolveGatewayModelProfile,
  withModelProfiles,
} from '../../src/provider-runtime/model-profiles.js';
import type {
  ModelProfileCatalogByCli,
  ProviderCapabilities,
} from '../../src/provider-runtime/types.js';

function capabilities(): ProviderCapabilities {
  return {
    available: true,
    version: '1.0.0',
    verified: false,
    modelSelection: true,
    effortSelection: true,
    modelOptions: [],
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
  };
}

describe('Gateway model profiles', () => {
  it('resolves official model and effort profiles', () => {
    const profile = resolveGatewayModelProfile(
      'codex',
      'gpt-5.6-luna',
      {},
      'max',
    );

    expect(OFFICIAL_GATEWAY_MODEL_PROFILE_CATALOG_VERSION).toBe(1);
    expect(profile).toMatchObject({
      source: 'official_default',
      selectedEffort: 'max',
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 92,
    });
    expect(profile?.strengths).toEqual([
      'More reliable edge-case handling while retaining strong cost/performance',
    ]);
  });

  it('merges broad and exact user overrides after official defaults', () => {
    const overrides: ModelProfileCatalogByCli = {
      codex: {
        '*': {
          costTier: 'unknown',
          effortProfiles: {
            max: { priority: 97 },
          },
        },
        'gpt-5.6-luna': {
          strengths: ['Local deployment specialty'],
          weaknesses: [],
        },
      },
    };

    expect(resolveGatewayModelProfile(
      'codex',
      'gpt-5.6-luna',
      overrides,
      'max',
    )).toMatchObject({
      source: 'merged',
      selectedEffort: 'max',
      strengths: ['Local deployment specialty'],
      weaknesses: [],
      costTier: 'unknown',
      priority: 97,
    });
  });

  it('supports user-only profiles for custom models', () => {
    const overrides: ModelProfileCatalogByCli = {
      opencode: {
        'local/*': {
          summary: 'Local model route.',
          costTier: 'low',
        },
      },
    };

    expect(resolveGatewayModelProfile('opencode', 'local/test', overrides))
      .toEqual({
        summary: 'Local model route.',
        costTier: 'low',
        source: 'user_override',
      });
    expect(resolveGatewayModelProfile('opencode', 'unprofiled/model', overrides))
      .toBeUndefined();
  });

  it('matches provider labels and includes Cursor defaults in scan output', () => {
    const antigravity = withModelProfiles('antigravity', {
      ...capabilities(),
      modelOptions: [{
        id: 'opaque-id',
        label: 'Gemini 3.5 Flash (High)',
        effortOptions: null,
      }],
    });
    const cursor = withModelProfiles('cursor', {
      ...capabilities(),
      modelOptions: [{
        id: 'gpt-5.6-sol-max',
        label: 'GPT-5.6 Sol 1M Max',
        effortOptions: null,
      }],
    });

    expect(antigravity.modelOptions?.[0]?.profile).toMatchObject({
      source: 'official_default',
      costTier: 'low',
      latencyTier: 'fast',
    });
    expect(cursor.modelOptions?.[0]?.profile).toMatchObject({
      source: 'official_default',
      recommendedFor: expect.arrayContaining(['code_review']),
    });
  });
});
