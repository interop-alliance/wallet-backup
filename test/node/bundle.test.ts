/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import * as tar from 'tar-stream'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  collectBytes,
  packSpaceArchive,
  readSpaceArchive,
  EXPORT_ENTRY_MTIME
} from '@interop/space-archive'
import {
  accountSpaceArchive,
  bundleManifestSummary,
  readBundle,
  writeBundle,
  BACKUP_CREDENTIAL_FILE,
  BUNDLE_ROLE
} from '../../src/index.js'
import type { Bundle, BundleMeta, ByteSource } from '../../src/index.js'

/**
 * The fixture account Space's id, packed below into a minimal archive: this
 * suite exercises the bundle codec, not the archive layout, so the archive's
 * content beyond its Space id is not load-bearing here.
 */
const FIXTURE_SPACE_ID = 'zFixtureSpace'

/**
 * The fixture unlock Space's id. Its archive is packed under its own id, so
 * the two archives in a fixture bundle differ byte for byte.
 */
const UNLOCK_SPACE_ID = 'zUnlockSpace'

/**
 * Packs a minimal Space archive for wrapping in a bundle.
 * @param [spaceId] {string}
 * @returns {Promise<Uint8Array>}
 */
async function packFixtureArchive(
  spaceId: string = FIXTURE_SPACE_ID
): Promise<Uint8Array> {
  return collectBytes(
    (await packSpaceArchive({
      spaceId,
      entries: [
        {
          name: `.space.${spaceId}.json`,
          bytes: new TextEncoder().encode(JSON.stringify({ id: spaceId }))
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
 * Drains a bundle stream, or a raw tar-stream pack, into its bytes.
 * @param pack {object}
 * @returns {Promise<Uint8Array>}
 */
async function packedBytes(
  pack: ReadableStream<Uint8Array> | tar.Pack
): Promise<Uint8Array> {
  return collectBytes(pack as ByteSource)
}

/**
 * Writes a two-Space bundle, each Space over its own fixture archive.
 * @param [options] {object}
 * @param [options.backupCredential] {unknown}
 * @param [options.unlockFirst] {boolean}   packs the unlock Space ahead of the
 *   account Space
 * @returns {Promise<Uint8Array>}
 */
async function writeFixtureBundle({
  backupCredential,
  unlockFirst = false
}: {
  backupCredential?: unknown
  unlockFirst?: boolean
} = {}): Promise<Uint8Array> {
  const account = {
    spaceId: FIXTURE_SPACE_ID,
    role: BUNDLE_ROLE.accountSpaceArchive,
    archive: await packFixtureArchive(FIXTURE_SPACE_ID)
  }
  const unlock = {
    spaceId: UNLOCK_SPACE_ID,
    role: BUNDLE_ROLE.unlockSpaceArchive,
    archive: await packFixtureArchive(UNLOCK_SPACE_ID)
  }
  return packedBytes(
    writeBundle({
      meta,
      spaces: unlockFirst ? [unlock, account] : [account, unlock],
      ...(backupCredential === undefined ? {} : { backupCredential })
    })
  )
}

/**
 * Reads the header `mtime` of every entry in a tar.
 * @param bytes {Uint8Array}
 * @returns {Promise<Array<{ name: string, mtime: Date | undefined }>>}
 */
async function entryMtimes(
  bytes: Uint8Array
): Promise<{ name: string; mtime: Date | undefined }[]> {
  const extract = tar.extract()
  const headers: { name: string; mtime: Date | undefined }[] = []
  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      headers.push({ name: header.name, mtime: header.mtime })
      stream.on('end', next)
      stream.resume()
    })
    extract.on('finish', resolve)
    extract.on('error', reject)
  })
  extract.end(bytes)
  await done
  return headers
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
    writeBundle({
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
    const packed = {
      form: 'plain',
      secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    }
    const bytes = await writeFixtureBundle({ backupCredential: packed })
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
    expect(BACKUP_CREDENTIAL_FILE).toBe('backup-credential.json')
    // The role anchors are permanent wire text, so they are pinned here as
    // literals rather than through the constants that write them.
    expect(bundle.manifest.contents).toEqual({
      'manifest.yml': {
        url: 'https://codeberg.org/fediverse/fep/src/branch/main/fep/6fcd/fep-6fcd.md#manifest-file'
      },
      'backup-credential.json': {
        url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/#packed-backup-credential'
      },
      spaces: {
        url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/#space-archives',
        contents: [
          {
            'zFixtureSpace.tar': {
              url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/#account-space-archive'
            }
          },
          {
            'zUnlockSpace.tar': {
              url: 'https://interop-alliance.github.io/portable-wallet-profile-spec/#unlock-space-archive'
            }
          }
        ]
      }
    })
    expect(
      JSON.parse(
        new TextDecoder().decode(bundle.files.get(BACKUP_CREDENTIAL_FILE))
      )
    ).toEqual(packed)
    expect([...bundle.roles.entries()]).toEqual([
      [`spaces/${FIXTURE_SPACE_ID}.tar`, BUNDLE_ROLE.accountSpaceArchive],
      [`spaces/${UNLOCK_SPACE_ID}.tar`, BUNDLE_ROLE.unlockSpaceArchive]
    ])

    const walked: string[] = []
    for await (const space of bundle.spaces) {
      walked.push(space.spaceId)
      const archive = await space.bytes()
      expect(
        Buffer.from(archive).equals(
          Buffer.from(await packFixtureArchive(space.spaceId))
        )
      ).toBe(true)
    }
    expect(walked).toEqual([FIXTURE_SPACE_ID, UNLOCK_SPACE_ID])
  })

  it('hands back the account Space archive verbatim', async () => {
    const archive = await packFixtureArchive(FIXTURE_SPACE_ID)
    // The unlock Space is packed first, so the account Space archive is found
    // by its role rather than by its position.
    const bundle = await readBundle(
      await writeFixtureBundle({ unlockFirst: true })
    )
    expect([...bundle.roles.keys()]).toEqual([
      `spaces/${UNLOCK_SPACE_ID}.tar`,
      `spaces/${FIXTURE_SPACE_ID}.tar`
    ])
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
    const archive = await packFixtureArchive(FIXTURE_SPACE_ID)
    expect(Buffer.from(found).equals(Buffer.from(archive))).toBe(true)
  })

  it('is byte-reproducible across two writes', async () => {
    const first = await writeFixtureBundle({ backupCredential: { form: 'x' } })
    const second = await writeFixtureBundle({ backupCredential: { form: 'x' } })
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)

    // Two writes a few milliseconds apart share a whole-second clock reading,
    // so the equality above alone does not prove the headers are pinned.
    const headers = await entryMtimes(first)
    expect(headers.map(header => header.name)).toEqual([
      'manifest.yml',
      'backup-credential.json',
      'spaces/',
      `spaces/${FIXTURE_SPACE_ID}.tar`,
      `spaces/${UNLOCK_SPACE_ID}.tar`
    ])
    for (const header of headers) {
      expect(header.mtime?.getTime()).toBe(EXPORT_ENTRY_MTIME.getTime())
    }
  })
})

describe('writeBundle stopping', () => {
  it('releases an archive source in flight when the consumer cancels', async () => {
    let releaseChunk!: () => void
    const chunkReady = new Promise<void>(resolve => {
      releaseChunk = resolve
    })
    let released = false
    let chunksAfterCancel = 0
    let cancelled = false
    async function* slowArchive(): AsyncGenerator<Uint8Array> {
      try {
        await chunkReady
        for (let index = 0; index < 4; index++) {
          if (cancelled) {
            chunksAfterCancel++
          }
          yield new Uint8Array(512)
        }
      } finally {
        released = true
      }
    }
    const stream = writeBundle({
      meta,
      spaces: [
        {
          spaceId: FIXTURE_SPACE_ID,
          role: BUNDLE_ROLE.accountSpaceArchive,
          archive: slowArchive()
        }
      ]
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    cancelled = true
    await stream.cancel()
    releaseChunk()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(released).toBe(true)
    expect(chunksAfterCancel).toBe(1)
  })

  it('skips settle once the writer has stopped', async () => {
    const controller = new AbortController()
    let settled = false
    const archive = await packFixtureArchive()
    // The abort lands once the archive's last chunk is taken, so the
    // collection completes and the writer reaches settle already stopped.
    async function* abortingArchive(): AsyncGenerator<Uint8Array> {
      yield archive
      controller.abort(new Error('the user cancelled'))
    }
    const stream = writeBundle({
      meta,
      spaces: [
        {
          spaceId: FIXTURE_SPACE_ID,
          role: BUNDLE_ROLE.accountSpaceArchive,
          archive: abortingArchive()
        }
      ],
      async settle() {
        settled = true
      },
      signal: controller.signal
    })

    const err = await collectBytes(stream).catch((err: unknown) => err)
    expect((err as Error).message).toBe('the user cancelled')
    expect(settled).toBe(false)
  })
})

describe('bundle refusals', () => {
  it('refuses bytes that are not a tar', async () => {
    const bytes = new TextEncoder().encode('not a tar archive at all')
    await expect(readBundle(bytes)).rejects.toMatchObject({
      name: 'BundleInvalidError',
      message: expect.stringContaining('not a readable tar archive')
    })
  })

  it('refuses a tar with no manifest', async () => {
    const bytes = await packRaw([{ name: 'readme.txt', body: 'hello' }])
    await expect(readBundle(bytes)).rejects.toMatchObject({
      name: 'BundleInvalidError',
      message: expect.stringContaining('does not open with a "manifest.yml"')
    })
  })

  it('refuses an unparseable manifest', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: '::: not : yaml :\n  - [' }
    ])
    await expect(readBundle(bytes)).rejects.toMatchObject({
      name: 'BundleInvalidError',
      message: expect.stringContaining('manifest is not valid YAML')
    })
  })

  it('refuses a manifest with no ubc-version', async () => {
    const bytes = await packRaw([
      { name: 'manifest.yml', body: YAML.stringify({ contents: {} }) }
    ])
    await expect(readBundle(bytes)).rejects.toMatchObject({
      name: 'BundleInvalidError',
      message: expect.stringContaining('carries no "ubc-version"')
    })
  })

  it('refuses a bundle whose manifest names no account Space archive', async () => {
    const archive = await packFixtureArchive()
    const bytes = await packedBytes(
      writeBundle({
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
    // The hand-built manifest parsed, so the refusal below is the "names one
    // it does not hold" branch rather than the "names none" one.
    expect([...bundle.roles.entries()]).toEqual([
      ['spaces/zAccount.tar', BUNDLE_ROLE.accountSpaceArchive]
    ])
    await expect(accountSpaceArchive(bundle)).rejects.toMatchObject({
      name: 'AccountSpaceArchiveMissingError',
      message: expect.stringContaining('"spaces/zAccount.tar"')
    })
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
