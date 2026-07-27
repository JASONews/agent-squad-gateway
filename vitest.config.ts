import { defineConfig } from 'vitest/config';

const webExecArgv = Number.parseInt(process.versions.node, 10) >= 22
  ? ['--no-experimental-webstorage']
  : [];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/web/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['tests/web/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./web/src/test/setup.ts'],
          execArgv: webExecArgv,
        },
      },
    ],
  },
});
