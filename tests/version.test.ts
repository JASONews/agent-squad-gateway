import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_SQUAD_GATEWAY_VERSION } from '../src/version.js';

describe('Agent Squad Gateway version', () => {
  it('matches the package manifest', () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(AGENT_SQUAD_GATEWAY_VERSION).toBe(packageMetadata.version);
  });
});
