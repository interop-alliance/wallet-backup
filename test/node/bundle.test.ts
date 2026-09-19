/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import * as tar from 'tar-stream'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  collectBytes,
  packSpaceArchive,
  readSpaceArchive
} from '@interop/space-archive'
import {
  accountSpaceArchive,
  bundleManifestSummary,
  readBundle,
  writeBundle,
  BUNDLE_ROLE,
  RECOVERY_CODE_FILE
} from '../../src/index.js'
import type { Bundle, BundleMeta } from '../../src/index.js'

/**
 * The fixture Space's id, packed below into a minimal archive: this suite
 * exercises the bundle codec, not the archive layout, so the archive's
 * content beyond its Space id is not load-bearing here.
 */
const FIXTURE_SPACE_ID = 'zFixtureSpace'

/**
 * Packs a minimal Space archive for wrapping in a bundle.
 * @returns {Promise<Uint8Array>}
 */
async function packFixtureArchive(): Promise<Uint8Array> {
  return collectBytes(
    (await packSpaceArchive({
      spaceId: FIXTURE_SPACE_ID,
      entries: [
        {
          name: `.space.${FIXTURE_SPACE_ID}.json`,
          bytes: new TextEncoder().encode(
            JSON.stringify({ id: FIXTURE_SPACE_ID })
          )
        }
      ]
    })) as unknown as AsyncIterable<Uint8Array>
  )
}

const meta: BundleMeta = {
  created: '2026-09-18T00:00:00.000Z',
  createdBy: {
    controller: 'did:webvh:zFixtureScid:example.com:space:s:id',
    client: { name: 'Test Wallet', url: 'https://wallet.example/' }
  }
}

/**
 * Drains a tar-stream pack into its bytes.
 * @param pack {object}
 * @returns {Promise<Uint8Array>}
 */
async function packedBytes(pack: unknown): Promise<Uint8Array> {
  return collectBytes(pack as AsyncIterable<Uint8Array>)
}

/**
 * Writes a two-Space bundle over the fixture archive.
 * @param [recoveryCode] {unknown}
 * @returns {Promise<Uint8Array>}
 */
async function writeFixtureBundle(recoveryCode?: unknown): Promise<Uint8Array> {
  const archive = await packFixtureArchive()
  return packedBytes(
    await writeBundle({
      meta,
      spaces: [
        {
          spaceId: FIXTURE_SPACE_ID,
          role: BUNDLE_ROLE.accountSpaceArchive,
          archive
        },
        {
          spaceId: 'zUnlockSpace',
          role: BUNDLE_ROLE.unlockSpaceArchive,
          archive
        }
      ],
      ...(recoveryCode === undefined ? {} : { recoveryCode })
    })
  )
}

/**
 * Packs an arbitrary tar for the refusal cases.
 * @param entries {Array<{ name: string, body: string }>}
 * @returns {Promise<Uint8Array>}
 */
async function packRaw(
  entries: { name: string; body: string }[]
): Promise<Uint8Array> {
  const pack = tar.pack()
  for (const entry of entries) {
    pack.entry({ name: entry.name }, entry.body)
  }
  pack.finalize()
  return packedBytes(pack)
}

/**
 * Reads the name of the error a thunk raises.
 * @param run {Function}
 * @returns {Promise<string>}
 */
async function errorName(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    return (err as Error).name
  }
  throw new Error('The call did not throw.')
}

/**
 * Wraps bytes as an async generator of small chunks, with a `finally` that
 * calls `onClose` once the source is released -- drained fully, or torn down
 * early through the iterator's `return()`.
 * @param options {object}
 * @param options.bytes {Uint8Array}
 * @param options.chunkSize {number}
 * @param options.onClose {Function}
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* flaggedChunks({
  bytes,
  chunkSize,
  onClose
}: {
  bytes: Uint8Array
  chunkSize: number
  onClose: () => void
}): AsyncGenerator<Uint8Array> {
  try {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      yield bytes.subarray(offset, offset + chunkSize)
    }
  } finally {
    onClose()
  }
}

/**
 * Writes a bundle whose second Space archive is large filler bytes, never
 * read by the tests below: it exists to keep the source unexhausted at the
 * point each test stops reading, so the release each test checks is proven by
 * the teardown path rather than by the source having drained on its own.
 * @returns {Promise<Uint8Array>}
 */
async function writeBundleWithLargeUnlockSpace(): Promise<Uint8Array> {
  const archive = await packFixtureArchive()
  return packedBytes(
    await writeBundle({
      meta,
      spaces: [
        {
          spaceId: FIXTURE_SPACE_ID,
          role: BUNDLE_ROLE.accountSpaceArchive,
          archive
        },
        {
          spaceId: 'zUnlockSpace',
          role: BUNDLE_ROLE.unlockSpaceArchive,
          archive: new Uint8Array(400_000)
        }
      ]
    })
  )
}

describe('writeBundle and readBundle', () => {
  it('round-trips a bundle and its Space archives', async () => {
    const bytes = await writeFixtureBundle({ form: 'plain', code: 'a-code' })
    const bundle = await readBundle(bytes)

    expect(bundle.manifest['ubc-version']).toBe('0.1')
    expect(bundle.manifest.spec).toEqual({
      id: 'https://w3id.org/pws/wallet-profile',
      version: '0.1',
      url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/'
    })
    expect(bundleManifestSummary(bundle.manifest)).toEqual({
      'ubc-version': '0.1',
      meta,
      spec: bundle.manifest.spec
    })
    expect(
      JSON.parse(new TextDecoder().decode(bundle.files.get(RECOVERY_CODE_FILE)))
    ).toEqual({ form: 'plain', code: 'a-code' })
    expect([...bundle.roles.entries()]).toEqual([
      [`spaces/${FIXTURE_SPACE_ID}.tar`, BUNDLE_ROLE.accountSpaceArchive],
      ['spaces/zUnlockSpace.tar', BUNDLE_ROLE.unlockSpaceArchive]
    ])

    const walked: string[] = []
    for await (const space of bundle.spaces) {
      walked.push(space.spaceId)
      await space.bytes()
    }
    expect(walked).toEqual([FIXTURE_SPACE_ID, 'zUnlockSpace'])
  })

  it('hands back the account Space archive verbatim', async () => {
    const archive = await packFixtureArchive()
    const bundle = await readBundle(await writeFixtureBundle())
    const found = await accountSpaceArchive(bundle)
    expect(Buffer.from(found).equals(Buffer.from(archive))).toBe(true)

    const space = await readSpaceArchive(found)
    expect(space.spaceId).toBe(FIXTURE_SPACE_ID)
  })

  it('reads a bundle handed in as a stream', async () => {
    const bytes = await writeFixtureBundle()
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.length; offset += 700) {
        yield bytes.subarray(offset, offset + 700)
      }
    }
    const bundle = await readBundle(chunks())
    expect(bundle.manifest['ubc-version']).toBe('0.1')
    const found = await accountSpaceArchive(bundle)
    expect(found.byteLength).toBeGreaterThan(0)
  })

  it('is byte-reproducible across two writes', async () => {
    const first = await writeFixtureBundle()
    const second = await writeFixtureBundle()
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
  })
})

describe('bundle refusals', () => {
  it('refuses bytes that are not a tar', async () => {
    const bytes = new TextEncoder().encode('not a tar archive at all')
    expect(await errorName(() => readBundle(bytes))).toBe('BundleInvalidError')
  })

  it('refuses a tar with no manifest', async () => {
    const bytes = await packRaw([{ name: 'readme.txt', body: 'hello' }])
    expect(await errorName(() => readBundle(bytes))).toBe('BundleInvalidError')
  })

  it('refuses an unparseable manifest', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: '::: not : yaml :\n  - [' }
    ])
    expect(await errorName(() => readBundle(bytes))).toBe('BundleInvalidError')
  })

  it('refuses a manifest with no ubc-version', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: YAML.stringify({ contents: {} }) }
    ])
    expect(await errorName(() => readBundle(bytes))).toBe('BundleInvalidError')
  })

  it('refuses a bundle whose manifest names no account Space archive', async () => {
    const archive = await packFixtureArchive()
    const bytes = await packedBytes(
      await writeBundle({
        meta,
        spaces: [
          {
            spaceId: 'zUnlockSpace',
            role: BUNDLE_ROLE.unlockSpaceArchive,
            archive
          }
        ]
      })
    )
    const bundle = await readBundle(bytes)
    expect(await errorName(() => accountSpaceArchive(bundle))).toBe(
      'AccountSpaceArchiveMissingError'
    )
  })

  it('refuses a bundle missing the account archive it names', async () => {
    const manifest = {
      'ubc-version': '0.1',
      meta,
      spec: { id: 'x', version: '0.1', url: 'x' },
      contents: {
        spaces: {
          url: BUNDLE_ROLE.spaceArchives,
          contents: [
            { 'zAccount.tar': { url: BUNDLE_ROLE.accountSpaceArchive } }
          ]
        }
      }
    }
    const bytes = await packRaw([
      { name: 'manifest.yml', body: YAML.stringify(manifest) },
      { name: 'spaces/zOther.tar', body: 'not the one' }
    ])
    const bundle: Bundle = await readBundle(bytes)
    expect(await errorName(() => accountSpaceArchive(bundle))).toBe(
      'AccountSpaceArchiveMissingError'
    )
  })
})

describe('bundle close and early release', () => {
  it('releases the source after accountSpaceArchive returns early', async () => {
    const bytes = await writeBundleWithLargeUnlockSpace()
    let closed = false
    const bundle = await readBundle(
      flaggedChunks({
        bytes,
        chunkSize: 512,
        onClose: () => {
          closed = true
        }
      })
    )
    await accountSpaceArchive(bundle)
    expect(closed).toBe(true)
  })

  it('releases the source on close() without iterating spaces', async () => {
    const bytes = await writeBundleWithLargeUnlockSpace()
    let closed = false
    const bundle = await readBundle(
      flaggedChunks({
        bytes,
        chunkSize: 512,
        onClose: () => {
          closed = true
        }
      })
    )
    await bundle.close()
    expect(closed).toBe(true)
  })

  it('releases the source when readBundle refuses an unparseable manifest', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: '::: not : yaml :\n  - [' },
      { name: 'padding.bin', body: 'x'.repeat(400_000) }
    ])
    let closed = false
    await expect(
      readBundle(
        flaggedChunks({
          bytes,
          chunkSize: 512,
          onClose: () => {
            closed = true
          }
        })
      )
    ).rejects.toMatchObject({ name: 'BundleInvalidError' })
    expect(closed).toBe(true)
  })

  it('releases the source when readBundle refuses a manifest with no ubc-version', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: YAML.stringify({ contents: {} }) },
      { name: 'padding.bin', body: 'x'.repeat(400_000) }
    ])
    let closed = false
    await expect(
      readBundle(
        flaggedChunks({
          bytes,
          chunkSize: 512,
          onClose: () => {
            closed = true
          }
        })
      )
    ).rejects.toMatchObject({ name: 'BundleInvalidError' })
    expect(closed).toBe(true)
  })

  it('does not yield a top-level file entry that trails the spaces directory', async () => {
    const manifest = {
      'ubc-version': '0.1',
      meta,
      spec: { id: 'x', version: '0.1', url: 'x' },
      contents: {}
    }
    const bytes = await packRaw([
      { name: 'manifest.yml', body: YAML.stringify(manifest) },
      { name: 'spaces/zSpace.tar', body: 'space bytes' },
      { name: 'trailer.txt', body: 'not a space archive' }
    ])
    const bundle = await readBundle(bytes)
    const walked: string[] = []
    for await (const space of bundle.spaces) {
      walked.push(space.path)
    }
    expect(walked).toEqual(['spaces/zSpace.tar'])
  })
})
