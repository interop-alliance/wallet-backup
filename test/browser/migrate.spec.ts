import { test, expect } from '@playwright/test'

test('migrates a chunked Resource in the browser, through the Blob path', async ({
  page
}) => {
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    // This callback runs in the browser; the '/...' specifier is a URL served
    // by the vite dev server, not a module path tsc can resolve from disk.
    // @ts-expect-error -- dev-server URL, resolved at runtime by vite
    const migration = await import('/test/browser/migration.ts')
    return migration.migrateChunkedBundle()
  })
  expect(result.chunkCount).toBeGreaterThan(1)
  expect(result.received).toEqual({
    contentType: 'image/png',
    bytes: result.written
  })
  expect(result.report.collections['photos']).toEqual({
    accepted: 1,
    skipped: 0,
    conflicting: 0,
    failed: 0,
    unopenable: 0
  })
})
