/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import { base64urlnopad } from '@scure/base'
import { collectBytes, packSpaceArchive } from '@interop/space-archive'
import {
  exportBundle,
  readBundle,
  unpackBackupCredential,
  BACKUP_CREDENTIAL_FILE,
  BUNDLE_ROLE
} from '../../src/index.js'
import type { BundleMeta } from '../../src/index.js'

const ACCOUNT_SPACE_ID = 'zAccountSpace'
const UNLOCK_SPACE_ID = 'zUnlockSpace'
const CREDENTIAL_SECRET = new Uint8Array(32).map((_, index) => index + 1)

const meta: BundleMeta = {
  created: '2026-09-20T00:00:00.000Z',
  createdBy: {
    controller: 'did:webvh:zFixtureScid:example.com:space:s:id',
    client: { name: 'Test Wallet', url: 'https://wallet.example/' }
  }
}

/**
 * The Spaces a healthy account names: the account Space and the unlock Space
 * the freshly established backup credential just wrote.
 */
const accountSpaces = [
  { spaceId: ACCOUNT_SPACE_ID, role: BUNDLE_ROLE.accountSpaceArchive },
  { spaceId: UNLOCK_SPACE_ID, role: BUNDLE_ROLE.unlockSpaceArchive }
]

/**
 * Packs a minimal Space archive, the stand-in for what a server's per-Space
 * export primitive answers.
 * @param spaceId {string}
 * @returns {Promise<Uint8Array>}
 */
async function packFixtureArchive(spaceId: string): Promise<Uint8Array> {
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

/**
 * Drains a tar-stream pack into its bytes.
 * @param pack {object}
 * @returns {Promise<Uint8Array>}
 */
async function packedBytes(pack: unknown): Promise<Uint8Array> {
  return collectBytes(pack as AsyncIterable<Uint8Array>)
}

/**
 * Reads the error a thunk raises.
 * @param run {Function}
 * @returns {Promise<Error>}
 */
async function raised(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (err) {
    return err as Error
  }
  throw new Error('The call did not throw.')
}

/**
 * The packed `backup-credential.json` document an opened bundle carries.
 * @param bundle {object}
 * @returns {unknown}
 */
function packedCredentialOf(bundle: {
  files: Map<string, Uint8Array>
}): unknown {
  const bytes = bundle.files.get(BACKUP_CREDENTIAL_FILE)
  if (bytes === undefined) {
    throw new Error('The bundle carries no packed backup credential.')
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('exportBundle', () => {
  it('establishes the credential before it lists the Spaces, and lists before it exports', async () => {
    const order: string[] = []
    let established = false
    await packedBytes(
      await exportBundle({
        meta,
        async establishBackupCredential() {
          order.push('establish-start')
          await Promise.resolve()
          established = true
          order.push('establish-end')
          return CREDENTIAL_SECRET.slice()
        },
        async listSpaces() {
          expect(established).toBe(true)
          order.push('list')
          return accountSpaces
        },
        async exportSpace({ spaceId }) {
          order.push(`export:${spaceId}`)
          return packFixtureArchive(spaceId)
        }
      })
    )

    expect(order).toEqual([
      'establish-start',
      'establish-end',
      'list',
      `export:${ACCOUNT_SPACE_ID}`,
      `export:${UNLOCK_SPACE_ID}`
    ])
  })

  it('zeroes the secret the host hands over once the credential is packed', async () => {
    const handed = CREDENTIAL_SECRET.slice()
    let zeroedBeforeList = false
    await packedBytes(
      await exportBundle({
        meta,
        establishBackupCredential: async () => handed,
        async listSpaces() {
          zeroedBeforeList = handed.every(byte => byte === 0)
          return accountSpaces
        },
        exportSpace: async ({ spaceId }) => packFixtureArchive(spaceId)
      })
    )
    expect(zeroedBeforeList).toBe(true)
  })

  it('writes a bundle whose plain credential and Space archives read back', async () => {
    const stages: { stage: string; spaceId?: string }[] = []
    const bytes = await packedBytes(
      await exportBundle({
        meta,
        establishBackupCredential: async () => CREDENTIAL_SECRET.slice(),
        listSpaces: async () => accountSpaces,
        exportSpace: async ({ spaceId }) => packFixtureArchive(spaceId),
        onProgress: options => stages.push(options)
      })
    )

    const bundle = await readBundle(bytes)
    expect(bundle.manifest.meta).toEqual(meta)
    expect([...bundle.roles.entries()]).toEqual([
      [`spaces/${ACCOUNT_SPACE_ID}.tar`, BUNDLE_ROLE.accountSpaceArchive],
      [`spaces/${UNLOCK_SPACE_ID}.tar`, BUNDLE_ROLE.unlockSpaceArchive]
    ])
    const document = packedCredentialOf(bundle)
    expect(document).toEqual({
      form: 'plain',
      secret: base64urlnopad.encode(CREDENTIAL_SECRET)
    })
    expect(await unpackBackupCredential({ document })).toEqual(
      CREDENTIAL_SECRET
    )

    const walked: string[] = []
    for await (const space of bundle.spaces) {
      walked.push(space.spaceId)
      expect((await space.bytes()).byteLength).toBeGreaterThan(0)
    }
    expect(walked).toEqual([ACCOUNT_SPACE_ID, UNLOCK_SPACE_ID])

    expect(stages).toEqual([
      { stage: 'establishing-credential' },
      { stage: 'exporting-space', spaceId: ACCOUNT_SPACE_ID },
      { stage: 'exporting-space', spaceId: UNLOCK_SPACE_ID },
      { stage: 'packing' }
    ])
  })

  it('seals the packed credential under an export passphrase', async () => {
    const exportPassphrase = 'correct horse battery staple'
    const bytes = await packedBytes(
      await exportBundle({
        meta,
        exportPassphrase,
        establishBackupCredential: async () => CREDENTIAL_SECRET.slice(),
        listSpaces: async () => accountSpaces,
        exportSpace: async ({ spaceId }) => packFixtureArchive(spaceId)
      })
    )

    const document = packedCredentialOf(await readBundle(bytes))
    expect(JSON.stringify(document)).not.toContain(
      base64urlnopad.encode(CREDENTIAL_SECRET)
    )
    expect(
      await unpackBackupCredential({ document, exportPassphrase })
    ).toEqual(CREDENTIAL_SECRET)
  })

  it('fails the whole ceremony when one Space export fails', async () => {
    const cause = new Error('the server refused')
    const err = await raised(() =>
      exportBundle({
        meta,
        establishBackupCredential: async () => CREDENTIAL_SECRET.slice(),
        listSpaces: async () => accountSpaces,
        async exportSpace({ spaceId }) {
          if (spaceId === UNLOCK_SPACE_ID) {
            throw cause
          }
          return packFixtureArchive(spaceId)
        }
      })
    )

    expect(err.message).toContain(UNLOCK_SPACE_ID)
    expect(err.cause).toBe(cause)
  })

  it('refuses a Space list naming no account Space', async () => {
    let exported = false
    const err = await raised(() =>
      exportBundle({
        meta,
        establishBackupCredential: async () => CREDENTIAL_SECRET.slice(),
        listSpaces: async () => [
          { spaceId: UNLOCK_SPACE_ID, role: BUNDLE_ROLE.unlockSpaceArchive }
        ],
        async exportSpace({ spaceId }) {
          exported = true
          return packFixtureArchive(spaceId)
        }
      })
    )

    expect(err.name).toBe('AccountSpaceArchiveMissingError')
    expect(exported).toBe(false)
  })

  it('aborts between stages', async () => {
    const controller = new AbortController()
    let listed = false
    const err = await raised(() =>
      exportBundle({
        meta,
        signal: controller.signal,
        async establishBackupCredential() {
          controller.abort(new Error('the user cancelled'))
          return CREDENTIAL_SECRET.slice()
        },
        async listSpaces() {
          listed = true
          return accountSpaces
        },
        exportSpace: async ({ spaceId }) => packFixtureArchive(spaceId)
      })
    )

    expect(err.message).toBe('the user cancelled')
    expect(listed).toBe(false)
  })

  it('aborts before a Space is exported', async () => {
    const controller = new AbortController()
    const err = await raised(() =>
      exportBundle({
        meta,
        signal: controller.signal,
        establishBackupCredential: async () => CREDENTIAL_SECRET.slice(),
        async listSpaces() {
          controller.abort(new Error('the user cancelled'))
          return accountSpaces
        },
        exportSpace: async ({ spaceId }) => packFixtureArchive(spaceId)
      })
    )

    expect(err.message).toBe('the user cancelled')
  })
})
