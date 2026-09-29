import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // `@interop/space-archive`'s dependencies read Node built-ins at load time
  // (`mime-types` takes `path.extname`, `tar-stream` takes `fs.constants`), so
  // the browser dev server gives them browser stand-ins. Vitest runs in Node
  // and keeps the real built-ins.
  resolve: {
    alias: process.env['VITEST']
      ? {}
      : {
          path: 'path-browserify',
          fs: fileURLToPath(
            new URL('./test/browser/emptyModule.ts', import.meta.url)
          )
        }
  },
  // The browser spec imports the source modules dynamically, so with a cold
  // dependency cache vite would discover their dependencies mid-evaluate,
  // re-optimize, and reload the page under the running test. Naming the
  // package entry point and the browser test helpers (which import packages
  // the entry point does not reach) as scan entries moves that work to
  // server start.
  optimizeDeps: {
    entries: [
      'src/index.ts',
      'test/browser/*.ts',
      '!test/browser/*.spec.ts',
      '!test/browser/emptyModule.ts'
    ]
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
