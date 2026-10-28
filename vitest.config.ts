// Two projects: `unit` (no server, run by `npm test`) and `integration` (against a mongod started by
// mongodb-memory-server, run by `npm run test:integration`).
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Modules that import `vscode` only for types or for classes used later get a small stub.
const alias = { vscode: path.resolve('test/stubs/vscode.ts') };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/mongod.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
