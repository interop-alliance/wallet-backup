import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The browser spec imports the source modules dynamically, so with a cold
  // dependency cache vite would discover their dependencies mid-evaluate,
  // re-optimize, and reload the page under the running test. Naming the
  // package entry point and the browser test helpers (which import packages
  // the entry point does not reach) as scan entries moves that work to
  // server start.
  optimizeDeps: {
    entries: ['src/index.ts', 'test/browser/*.ts', '!test/browser/*.spec.ts']
  },
  test: {
    include: ['test/node/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts']
    }
  }
})
