import { test, expect } from '@playwright/test'

test('packs and reads an archive and a bundle in the browser', async ({
  page
}) => {
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    // This callback runs in the browser; the '/...' specifiers are URLs
    // served by the vite dev server, not module paths tsc can resolve from
    // disk. The bundle codec is imported directly, since only it is
    // exercised from this package here. The archive codec now lives in
    // `@interop/space-archive`, a bare package specifier a page script
    // cannot resolve without an import map, so it is reached through this
    // test's own vite-servable door onto that package instead.
    // @ts-expect-error -- dev-server URL, resolved at runtime by vite
    const archive = await import('/test/browser/spaceArchive.ts')
    // @ts-expect-error -- dev-server URL, resolved at runtime by vite
    const bundle = await import('/src/bundle/index.ts')

    const pack = await archive.packSpaceArchive({
      spaceId: 'zBrowserSpace',
      entries: [
        {
          name: '.space.zBrowserSpace.json',
          bytes: new TextEncoder().encode('{"id":"zBrowserSpace"}')
        }
      ]
    })
    const archiveBytes = await archive.collectBytes(pack)

    const bundleBytes = await archive.collectBytes(
      await bundle.writeBundle({
        meta: {
          created: '2026-09-18T00:00:00.000Z',
          createdBy: {
            controller: 'did:key:z6MkBrowser',
            client: { name: 'Browser', url: 'https://example/' }
          }
        },
        spaces: [
          {
            spaceId: 'zBrowserSpace',
            role: bundle.BUNDLE_ROLE.accountSpaceArchive,
            archive: archiveBytes
          }
        ]
      })
    )

    const opened = await bundle.readBundle(bundleBytes)
    const accountArchive = await bundle.accountSpaceArchive(opened)
    const space = await archive.readSpaceArchive(accountArchive)
    const paths: string[] = []
    for await (const entry of space.entries) {
      paths.push(entry.name)
    }
    return { spaceId: space.spaceId, paths }
  })
  expect(result.spaceId).toBe('zBrowserSpace')
  expect(result.paths).toContain(
    'space/zBrowserSpace/.space.zBrowserSpace.json'
  )
})
