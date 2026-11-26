import { defineConfig } from 'vitest/config'

// Pin the test root to this bundle. Without a local config vitest walks up and
// inherits the repo root's app/flowix-web-only include list, hiding these tests.
export default defineConfig({
  // Vite walks up and finds the repo root postcss.config.js, which requires
  // tailwindcss — a dependency only the root workspace installs. These node
  // tests never process CSS, so disable postcss config discovery entirely.
  css: { postcss: {} },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
