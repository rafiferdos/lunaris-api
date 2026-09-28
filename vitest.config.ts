import { defineConfig } from 'vitest/config';
import { loadEnvFile } from 'node:process';
try {
  loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: [
        'src/modules/scoring/**',
        'src/modules/xp/**',
        'src/modules/rating/**',
        'src/modules/integrity/**',
        'src/modules/attempts/**',
      ],
    },
  },
});
