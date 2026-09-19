/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The two migration secrets that run through the keyring's Argon2id
 * derivation -- an unlock passphrase, and a packed recovery code sealed to an
 * export passphrase -- and the wipe the walk owes its caller when it ends.
 *
 * Both wallet-core subpaths the walk derives through are wrapped here rather
 * than replaced: the real functions run, and the wrapper keeps a reference to
 * the bytes they produced so the test can assert the walk zeroed them. A spy
 * is the only way to see that from outside, since the walk deliberately hands
 * no key material back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deriveUnlockSeed, KEYRING_KDF } from '@interop/wallet-core/keyring'
import { standingClientFromUnlockSeed } from '@interop/wallet-core/unlock'
import {
  generateRecoveryCode,
  recoveryClientFromCode
} from '@interop/wallet-core/recovery'
import { CONTACTS_COLLECTION } from '@interop/social-core'
import {
  migrateBundle,
  packRecoveryCode,
  unpackRecoveryCode
} from '../../src/index.js'
import type { MigrationSink, SinkOutcome } from '../../src/index.js'
import {
  buildBundle,
  collectionDescriptor,
  collectionDir,
  collectionLogFile,
  encryptRows,
  jsonFile,
  keyMapDir,
  logBody,
  mintGenerations,
  recipientFor,
  rosterDescriptor,
  FIXTURE_SPACE_ID
} from '../fixtures/migration/bundle.js'

/**
 * The generations the walk recovered, captured as `unwrapUserKeyGenerations`
 * hands them back, so the test can read their secrets after the walk.
 */
const recovered: Array<{ id: string; secret: Uint8Array }> = []

/**
 * Every unlock seed derived during a test, same reason.
 */
const seeds: Uint8Array[] = []

vi.mock('@interop/wallet-core/keys', async importOriginal => {
  const original =
    await importOriginal<typeof import('@interop/wallet-core/keys')>()
  return {
    ...original,
    async unwrapUserKeyGenerations(
      options: Parameters<typeof original.unwrapUserKeyGenerations>[0]
    ) {
      const generations = await original.unwrapUserKeyGenerations(options)
      recovered.push(...generations)
      return generations
    }
  }
})

vi.mock('@interop/wallet-core/keyring', async importOriginal => {
  const original =
    await importOriginal<typeof import('@interop/wallet-core/keyring')>()
  return {
    ...original,
    async deriveUnlockSeed(
      options: Parameters<typeof original.deriveUnlockSeed>[0]
    ) {
      const seed = await original.deriveUnlockSeed(options)
      seeds.push(seed)
      return seed
    }
  }
})

const PASSPHRASE = 'correct horse battery staple'
const EXPORT_PASSPHRASE = 'an export passphrase'

/**
 * A sink that accepts everything and counts the rows it saw.
 * @returns {MigrationSink & { rows: unknown[] }}
 */
function acceptingSink(): MigrationSink & { rows: unknown[] } {
  const rows: unknown[] = []

  /**
   * @param options {object}
   * @param options.row {unknown}
   * @returns {Promise<SinkOutcome>}
   */
  async function record({ row }: { row: unknown }): Promise<SinkOutcome> {
    rows.push(row)
    return 'accepted'
  }

  return {
    rows,
    importCredential: record,
    importContact: record,
    importContactRevision: record,
    importActivity: record
  }
}

/**
 * Builds a one-collection fixture bundle whose roster is wrapped to the given
 * recipients.
 *
 * @param options {object}
 * @param options.recipients {Array<{ id: string, publicKeyMultibase: string }>}
 * @param [options.recoveryCode] {unknown}   the packed code document
 * @returns {Promise<Uint8Array>}
 */
async function oneCollectionBundle({
  recipients,
  recoveryCode
}: {
  recipients: Array<{ id: string; publicKeyMultibase: string }>
  recoveryCode?: unknown
}): Promise<Uint8Array> {
  const [generation] = await mintGenerations(1)
  const roster = await rosterDescriptor({
    generations: [generation!],
    recipients
  })
  const encryption = await collectionDescriptor({ openedBy: [[generation!]] })
  const entries = [
    jsonFile({
      name: `.space.${FIXTURE_SPACE_ID}.json`,
      document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
    }),
    keyMapDir(logBody(roster)),
    collectionDir({
      collectionId: CONTACTS_COLLECTION,
      files: [
        collectionLogFile({
          collectionId: CONTACTS_COLLECTION,
          body: logBody(encryption)
        }),
        ...(await encryptRows({
          collectionId: CONTACTS_COLLECTION,
          encryption,
          rows: [{ contactId: 'c-1' }]
        }))
      ]
    })
  ]
  return buildBundle({
    entries,
    ...(recoveryCode !== undefined && { recoveryCode })
  })
}

describe('migrateBundle secrets', () => {
  const realFetch = globalThis.fetch

  beforeAll(() => {
    globalThis.fetch = (() => {
      throw new Error('The migration walk issued an HTTP request.')
    }) as typeof globalThis.fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it('opens the bundle with the account unlock passphrase', async () => {
    const unlockSeed = await deriveUnlockSeed({
      secret: PASSPHRASE,
      kdf: KEYRING_KDF
    })
    const client = await standingClientFromUnlockSeed({ unlockSeed })
    const bundle = await oneCollectionBundle({
      recipients: [recipientFor(client.agents.keyAgreementKey)]
    })
    const sink = acceptingSink()
    const report = await migrateBundle({
      bundle,
      secret: { passphrase: PASSPHRASE },
      sink
    })
    expect(sink.rows).toEqual([{ contactId: 'c-1' }])
    expect(report.collections[CONTACTS_COLLECTION]!.accepted).toBe(1)
  }, 120000)

  it('opens the bundle with a sealed packed recovery code', async () => {
    const code = generateRecoveryCode()
    const client = await recoveryClientFromCode({ code })
    const bundle = await oneCollectionBundle({
      recipients: [recipientFor(client.agents.keyAgreementKey)],
      recoveryCode: await packRecoveryCode({
        code,
        exportPassphrase: EXPORT_PASSPHRASE
      })
    })
    const sink = acceptingSink()
    await migrateBundle({
      bundle,
      secret: { packedCode: { exportPassphrase: EXPORT_PASSPHRASE } },
      sink
    })
    expect(sink.rows).toEqual([{ contactId: 'c-1' }])
  }, 120000)

  it('zeroes every generation secret and the derived seed when the walk ends', async () => {
    recovered.length = 0
    seeds.length = 0
    const unlockSeed = await deriveUnlockSeed({
      secret: PASSPHRASE,
      kdf: KEYRING_KDF
    })
    const client = await standingClientFromUnlockSeed({ unlockSeed })
    const bundle = await oneCollectionBundle({
      recipients: [recipientFor(client.agents.keyAgreementKey)]
    })
    // The seed derived to build the fixture is not the walk's; only the ones
    // the walk derives after this point are asserted on.
    seeds.length = 0
    await migrateBundle({
      bundle,
      secret: { passphrase: PASSPHRASE },
      sink: acceptingSink()
    })

    expect(recovered.length).toBeGreaterThan(0)
    for (const generation of recovered) {
      expect(generation.secret.every(byte => byte === 0)).toBe(true)
    }
    expect(seeds.length).toBeGreaterThan(0)
    for (const seed of seeds) {
      expect(seed.every(byte => byte === 0)).toBe(true)
    }
  }, 120000)

  it('zeroes the export passphrase seed on the packed-code path', async () => {
    const code = generateRecoveryCode()
    const client = await recoveryClientFromCode({ code })
    // `packRecoveryCode` derives one seed of its own, so the assertion covers
    // the sealing side too.
    seeds.length = 0
    const packed = await packRecoveryCode({
      code,
      exportPassphrase: EXPORT_PASSPHRASE
    })
    expect(seeds).toHaveLength(1)
    expect(seeds[0]!.every(byte => byte === 0)).toBe(true)

    const bundle = await oneCollectionBundle({
      recipients: [recipientFor(client.agents.keyAgreementKey)],
      recoveryCode: packed
    })
    recovered.length = 0
    seeds.length = 0
    await migrateBundle({
      bundle,
      secret: { packedCode: { exportPassphrase: EXPORT_PASSPHRASE } },
      sink: acceptingSink()
    })

    expect(seeds).toHaveLength(1)
    for (const seed of seeds) {
      expect(seed.every(byte => byte === 0)).toBe(true)
    }
    expect(recovered.length).toBeGreaterThan(0)
    for (const generation of recovered) {
      expect(generation.secret.every(byte => byte === 0)).toBe(true)
    }
  }, 120000)

  it('zeroes the export passphrase seed on a direct unpack', async () => {
    const code = generateRecoveryCode()
    const packed = await packRecoveryCode({
      code,
      exportPassphrase: EXPORT_PASSPHRASE
    })
    seeds.length = 0
    expect(
      await unpackRecoveryCode({
        document: packed,
        exportPassphrase: EXPORT_PASSPHRASE
      })
    ).toBe(code)
    expect(seeds).toHaveLength(1)
    expect(seeds[0]!.every(byte => byte === 0)).toBe(true)
  }, 120000)
})
