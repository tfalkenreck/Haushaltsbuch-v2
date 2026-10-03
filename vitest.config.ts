import { defineConfig } from 'vitest/config';

// Ein Testlauf für das ganze Repo, getrennt in die Projekte backend und frontend.
// Aufruf vom Root: `npm test` (einmalig) oder `npm run test:watch`.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'backend',
          root: './backend',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        extends: './frontend/vite.config.ts',
        test: {
          name: 'frontend',
          root: './frontend',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
