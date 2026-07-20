import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));

  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (metadata.name === '@jasonews/agent-squad-gateway'
        && typeof metadata.version === 'string') {
        return metadata.version;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error('Unable to locate Agent Squad Gateway package metadata');
}

export const AGENT_SQUAD_GATEWAY_VERSION = readPackageVersion(import.meta.url);
