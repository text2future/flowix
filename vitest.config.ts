import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, 'app/flowix-web');

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['app/flowix-web/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': frontendRoot,
      '@app': resolve(frontendRoot, 'app'),
      '@features': resolve(frontendRoot, 'features'),
      '@platform': resolve(frontendRoot, 'platform'),
      '@shared': resolve(frontendRoot, 'shared'),
    },
  },
});
