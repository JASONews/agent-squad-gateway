import { resolve } from 'node:path';
import { build } from 'vite';

export default async function globalSetup(): Promise<void> {
  await build({
    configFile: resolve('vite.config.ts'),
    logLevel: 'warn',
  });
}
