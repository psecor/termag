import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    // A docs site, so the links that only show with one (settingsDocs.ts) are under test.
    env: { VITE_DOCS_SITE_URL: 'https://docs.example.test/' },
  },
});
