import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The browser spec imports the source modules dynamically, so with a cold
  // dependency cache vite would discover their dependencies mid-evaluate,
  // re-optimize, and reload the page under the running test. Naming the
  // package entry point as a scan entry moves that work to server start.
  optimizeDeps: {
    entries: ['src/index.ts']
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
