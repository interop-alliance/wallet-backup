/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The migration walk, over fixture bundles built in this process: the happy
 * path per standard collection, the refusals that come before any row is
 * written, the per-row and per-collection failure rules, and the two stops.
 * Every test installs a `fetch` that throws, so a walk that reached the
 * network would fail loudly rather than quietly work.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BACKUP_CREDENTIAL_KDF,
  deriveUnlockSeed
} from '@interop/wallet-core/keyring/kdf'
import { standingClientFromUnlockSeed } from '@interop/wallet-core/unlock/standingClient'
import {
  generateRecoveryCode,
  recoveryClientFromCode
} from '@interop/wallet-core/recovery/recoveryCode'
import {
  PRIVATE_CREDENTIALS_COLLECTION,
  WALLET_ACTIVITY_COLLECTION,
  APP_CONNECTIONS_COLLECTION
} from '@interop/wallet-core/space/collections'
import {
  CONTACTS_COLLECTION,
  CONTACTS_HISTORY_COLLECTION
} from '@interop/social-core'
import {
  EDV_SCHEME_VERSION,
  EPOCH_CONFIGURATION_STATE_TYPE
} from '@interop/was-client/edv/core'
import type { RecipientPublicKey } from '@interop/was-client/edv/core'
import type { IndexSchema } from '@interop/was-client'
import type { ArchiveFile } from '@interop/space-archive'
import {
  collectBytes,
  fileNameFor,
  packSpaceArchive
} from '@interop/space-archive'
import {
  migrateBundle,
  packBackupCredential,
  writeBundle,
  BUNDLE_ROLE
} from '../../src/index.js'
import type {
  AppCollectionRow,
  MigrationCollectionReport,
  MigrationReport,
  MigrationSecret,
  MigrationSink,
  SinkOutcome
} from '../../src/index.js'
import {
  buildBundle,
  collectionDescriptor,
  collectionDir,
  collectionLogFile,
  chunkDir,
  encryptRows,
  jsonFile,
  keyMapDir,
  logBody,
  mintGenerations,
  plaintextRows,
  sealedCustom,
  recipientFor,
  rosterDescriptor,
  FIXTURE_META,
  FIXTURE_SPACE_ID
} from '../fixtures/migration/bundle.js'
import type { Generation } from '../fixtures/migration/bundle.js'

/**
 * One collection of a fixture account.
 */
interface FixtureCollection {
  collectionId: string
  rows: unknown[]
  openedBy: Generation[][]
  log?: 'wrapped' | 'broken' | 'omit'
  chunked?: string[]
  /** rows written as plain JSON under `row-<n>` ids, with no collection log */
  plaintext?: boolean
  /** the Collection Metadata file's body */
  metadata?: unknown
  /** leaves the Collection Metadata file out, or writes it as non-JSON bytes */
  metadataFile?: 'omit' | 'broken'
  /** further files written verbatim into the collection directory */
  extraFiles?: Array<{ name: string; bytes: Uint8Array }>
  /** the generations the descriptor's blinded-index key is wrapped to */
  hmacFor?: Generation[]
  /**
   * an index schema sealed into the metadata `custom` by `by`, bound to
   * `boundTo` (the collection's own id by default), under the first epoch
   * when `underFirstEpoch` is set and the current one otherwise
   */
  sealedIndexSchema?: {
    schema: IndexSchema
    by: Generation
    boundTo?: string
    underFirstEpoch?: boolean
  }
}

/**
 * Derives a recovery code secret and the roster recipient entry it stands for.
 * @returns {Promise<{ code: string, recipient: RecipientPublicKey }>}
 */
async function recoverySecret(): Promise<{
  code: string
  recipient: RecipientPublicKey
}> {
  const code = generateRecoveryCode()
  const client = await recoveryClientFromCode({ code })
  return { code, recipient: recipientFor(client.agents.keyAgreementKey) }
}

/**
 * A per-collection report tally: all counts zero, with the given overrides.
 * @param [overrides] {Partial<MigrationCollectionReport>}
 * @returns {MigrationCollectionReport}
 */
function tally(
  overrides: Partial<MigrationCollectionReport> = {}
): MigrationCollectionReport {
  return {
    accepted: 0,
    skipped: 0,
    conflicting: 0,
    failed: 0,
    unopenable: 0,
    ...overrides
  }
}

/**
 * A verbatim collection file with UTF-8 text content.
 * @param name {string}
 * @param text {string}
 * @returns {{ name: string, bytes: Uint8Array }}
 */
function textFile(
  name: string,
  text: string
): { name: string; bytes: Uint8Array } {
  return { name, bytes: new TextEncoder().encode(text) }
}

/**
 * A collection policy file with the given body text.
 * @param body {string}
 * @returns {{ name: string, bytes: Uint8Array }}
 */
function policyFile(body: string): { name: string; bytes: Uint8Array } {
  return textFile('.collection.policy.json', body)
}

/**
 * Assembles a fixture bundle: a user key roster wrapped to the given
 * recipients, then one archive directory per collection.
 *
 * @param options {object}
 * @param options.generations {Generation[]}   oldest first
 * @param options.recipients {RecipientPublicKey[]}
 * @param options.collections {FixtureCollection[]}
 * @param [options.rosterWithoutWrapFor] {ReadonlySet<string>}
 * @param [options.backupCredential] {unknown}   the packed credential
 *   document
 * @returns {Promise<Uint8Array>}
 */
async function fixtureBundle({
  generations,
  recipients,
  collections,
  rosterWithoutWrapFor,
  backupCredential
}: {
  generations: Generation[]
  recipients: RecipientPublicKey[]
  collections: FixtureCollection[]
  rosterWithoutWrapFor?: ReadonlySet<string>
  backupCredential?: unknown
}): Promise<Uint8Array> {
  const roster = await rosterDescriptor({
    generations,
    recipients,
    ...(rosterWithoutWrapFor !== undefined && {
      withoutWrapFor: rosterWithoutWrapFor
    })
  })
  const entries = [
    jsonFile({
      name: `.space.${FIXTURE_SPACE_ID}.json`,
      document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
    }),
    keyMapDir(logBody(roster))
  ]
  for (const collection of collections) {
    let metadata = collection.metadata
    let leadingFiles: ArchiveFile[]
    if (collection.plaintext === true) {
      leadingFiles = plaintextRows(collection.rows)
    } else {
      const encryption = await collectionDescriptor({
        openedBy: collection.openedBy,
        ...(collection.hmacFor !== undefined && { hmacFor: collection.hmacFor })
      })
      if (collection.sealedIndexSchema !== undefined) {
        const { schema, by, boundTo, underFirstEpoch } =
          collection.sealedIndexSchema
        const sealingEncryption =
          underFirstEpoch === true
            ? { ...encryption, currentEpoch: encryption.epochs![0]!.id }
            : encryption
        metadata = {
          id: collection.collectionId,
          custom: await sealedCustom({
            collectionId: boundTo ?? collection.collectionId,
            encryption: sealingEncryption,
            generation: by,
            indexSchema: schema
          })
        }
      }
      const log = collection.log ?? 'wrapped'
      leadingFiles = [
        ...(log === 'omit'
          ? []
          : [
              collectionLogFile({
                collectionId: collection.collectionId,
                body: log === 'broken' ? 'not a log' : logBody(encryption)
              })
            ]),
        ...(await encryptRows({
          collectionId: collection.collectionId,
          encryption,
          rows: collection.rows
        }))
      ]
    }
    entries.push(
      collectionDir({
        collectionId: collection.collectionId,
        metadata,
        ...(collection.metadataFile !== undefined && {
          metadataFile: collection.metadataFile
        }),
        files: [
          ...leadingFiles,
          ...(collection.extraFiles ?? []),
          ...(collection.chunked ?? []).map(chunkDir)
        ]
      })
    )
  }
  return buildBundle({
    entries,
    ...(backupCredential !== undefined && { backupCredential })
  })
}

/**
 * A sink that records every call and answers with whatever the caller's
 * `answer` function returns (or throws).
 *
 * @param [answer] {function}   `({ collectionId, index }) => SinkOutcome`
 * @returns {MigrationSink & { calls: Array<{ collectionId: string, resourceId: string, row: unknown }> }}
 */
function recordingSink(
  answer?: (options: {
    collectionId: string
    index: number
    row: unknown
  }) => SinkOutcome
): MigrationSink & {
  calls: Array<{ collectionId: string; resourceId: string; row: unknown }>
} {
  const calls: Array<{
    collectionId: string
    resourceId: string
    row: unknown
  }> = []
  const seen = new Map<string, number>()

  /**
   * The one import function every sink method delegates to.
   * @param options {object}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.row {unknown}
   * @returns {Promise<SinkOutcome>}
   */
  async function record({
    collectionId,
    resourceId,
    row
  }: {
    collectionId: string
    resourceId: string
    row: unknown
  }): Promise<SinkOutcome> {
    calls.push({ collectionId, resourceId, row })
    const index = seen.get(collectionId) ?? 0
    seen.set(collectionId, index + 1)
    return answer ? answer({ collectionId, index, row }) : 'accepted'
  }

  return {
    calls,
    importCredential: record,
    importContact: record,
    importContactRevision: record,
    importActivity: record
  }
}

/**
 * A recording sink that also migrates app collections. `events` lists every
 * `ensure:<id>` and `row:<id>` call in order, `ensured` keeps each
 * `ensureCollection` argument, and `appRows` keeps each `importRow` argument.
 *
 * @param [options] {object}
 * @param [options.answer] {function}   as {@link recordingSink} takes it
 * @param [options.ensure] {function}   runs inside `ensureCollection`, and may
 *   throw
 * @returns {object}
 */
function appRecordingSink({
  answer,
  ensure
}: {
  answer?: (options: {
    collectionId: string
    index: number
    row: unknown
  }) => SinkOutcome
  ensure?: (collectionId: string) => void
} = {}) {
  const sink = recordingSink(answer)
  const events: string[] = []
  const ensured: Array<
    Parameters<
      NonNullable<MigrationSink['appCollections']>['ensureCollection']
    >[0]
  > = []
  const appRows: AppCollectionRow[] = []
  return {
    ...sink,
    events,
    ensured,
    appRows,
    appCollections: {
      async ensureCollection(options: (typeof ensured)[number]): Promise<void> {
        events.push(`ensure:${options.collectionId}`)
        ensured.push(options)
        ensure?.(options.collectionId)
      },
      async importRow(options: AppCollectionRow): Promise<SinkOutcome> {
        events.push(`row:${options.collectionId}`)
        appRows.push(options)
        const { collectionId, resourceId } = options
        const row = 'row' in options ? options.row : options.bytes
        return sink.importContact({ collectionId, resourceId, row })
      }
    }
  }
}

/**
 * Mints generations, builds a bundle from the collections they open, and
 * migrates it into an app-collections sink with a recovery code.
 *
 * @param options {object}
 * @param options.collections {function}   builds the fixture collections from
 *   the minted generations, oldest first
 * @param [options.generationCount] {number}   1 by default
 * @param [options.sink] {ReturnType<typeof appRecordingSink>}
 * @returns {Promise<{ sink: ReturnType<typeof appRecordingSink>, report: MigrationReport }>}
 */
async function runApp({
  collections,
  generationCount = 1,
  sink = appRecordingSink()
}: {
  collections: (generations: Generation[]) => FixtureCollection[]
  generationCount?: number
  sink?: ReturnType<typeof appRecordingSink>
}): Promise<{
  sink: ReturnType<typeof appRecordingSink>
  report: MigrationReport
}> {
  const generations = await mintGenerations(generationCount)
  const { code, recipient } = await recoverySecret()
  const bundle = await fixtureBundle({
    generations,
    recipients: [recipient],
    collections: collections(generations)
  })
  const report = await migrateBundle({
    bundle,
    secret: { recoveryCode: code },
    sink
  })
  return { sink, report }
}

/**
 * The four standard collections, one row each, all opened by one generation.
 * @param generation {Generation}
 * @returns {FixtureCollection[]}
 */
function standardCollections(generation: Generation): FixtureCollection[] {
  return [
    {
      collectionId: CONTACTS_COLLECTION,
      rows: [{ contactId: 'c-1' }],
      openedBy: [[generation]]
    },
    {
      collectionId: CONTACTS_HISTORY_COLLECTION,
      rows: [{ contactId: 'c-1', action: 'create' }],
      openedBy: [[generation]]
    },
    {
      collectionId: PRIVATE_CREDENTIALS_COLLECTION,
      rows: [{ cid: 'z-cred' }],
      openedBy: [[generation]]
    },
    {
      collectionId: WALLET_ACTIVITY_COLLECTION,
      rows: [{ id: 'act-1' }],
      openedBy: [[generation]]
    }
  ]
}

describe('migrateBundle', () => {
  const realFetch = globalThis.fetch

  beforeAll(() => {
    globalThis.fetch = (() => {
      throw new Error('The migration walk issued an HTTP request.')
    }) as typeof globalThis.fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it('opens one row per standard collection with the recovery code', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!)
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })

    expect(sink.calls.map(call => call.collectionId)).toEqual([
      CONTACTS_COLLECTION,
      CONTACTS_HISTORY_COLLECTION,
      PRIVATE_CREDENTIALS_COLLECTION,
      WALLET_ACTIVITY_COLLECTION
    ])
    expect(sink.calls[0]!.row).toEqual({ contactId: 'c-1' })
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]).toEqual({
      accepted: 1,
      skipped: 0,
      conflicting: 0,
      failed: 0,
      unopenable: 0
    })
    expect(report.manifest.meta.createdBy.client.name).toBe('Fixture Wallet')
    expect(report.stoppedAt).toBeUndefined()
  })

  it('opens the bundle with a plain packed backup credential', async () => {
    const [generation] = await mintGenerations(1)
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const client = await standingClientFromUnlockSeed({
      unlockSeed: await deriveUnlockSeed({ secret, kdf: BACKUP_CREDENTIAL_KDF })
    })
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipientFor(client.agents.keyAgreementKey)],
      collections: standardCollections(generation!),
      backupCredential: await packBackupCredential({ secret })
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { packedCredential: {} },
      sink
    })
    expect(sink.calls).toHaveLength(4)
    expect(report.collections[CONTACTS_COLLECTION]!.accepted).toBe(1)
  })

  it('refuses a secret that is a recipient of nothing, before any sink call', async () => {
    const [generation] = await mintGenerations(1)
    const { recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!)
    })
    const sink = recordingSink()
    await expect(
      migrateBundle({
        bundle,
        secret: { recoveryCode: generateRecoveryCode() },
        sink
      })
    ).rejects.toMatchObject({ name: 'BundleRecipientMissingError' })
    expect(sink.calls).toHaveLength(0)
  })

  it('opens pre-rotation generations with a retired secret, and refuses one established after the export', async () => {
    const [older, newer] = await mintGenerations(2)
    const retired = await recoverySecret()
    const current = await recoverySecret()
    // The retired secret is a recipient of the first roster epoch alone; the
    // current one of both, as an escrow leaves them.
    const roster = await rosterDescriptor({
      generations: [older!, newer!],
      recipients: [current.recipient]
    })
    const retiredEpoch = await rosterDescriptor({
      generations: [older!],
      recipients: [retired.recipient, current.recipient]
    })
    roster.epochs![0] = retiredEpoch.epochs![0]!

    const entries = [
      jsonFile({
        name: `.space.${FIXTURE_SPACE_ID}.json`,
        document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
      }),
      keyMapDir(logBody(roster))
    ]
    const encryption = await collectionDescriptor({ openedBy: [[older!]] })
    entries.push(
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
            rows: [{ contactId: 'c-old' }]
          }))
        ]
      })
    )
    const bundle = await buildBundle({ entries })

    const retiredSink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: retired.code },
      sink: retiredSink
    })
    expect(report.collections[CONTACTS_COLLECTION]!.accepted).toBe(1)

    // A secret enrolled after the export is in no archived epoch at all.
    const laterSink = recordingSink()
    await expect(
      migrateBundle({
        bundle,
        secret: { recoveryCode: (await recoverySecret()).code },
        sink: laterSink
      })
    ).rejects.toMatchObject({ name: 'BundleRecipientMissingError' })
    expect(laterSink.calls).toHaveLength(0)
  })

  it('opens every row of a torn cascade', async () => {
    const [older, newer] = await mintGenerations(2)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [older!, newer!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }],
          openedBy: [[newer!]]
        },
        {
          collectionId: PRIVATE_CREDENTIALS_COLLECTION,
          rows: [{ cid: 'z-1' }],
          openedBy: [[older!]]
        }
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(sink.calls).toHaveLength(2)
    expect(report.collections[CONTACTS_COLLECTION]!.accepted).toBe(1)
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]!.accepted).toBe(1)
    expect(report.collections[CONTACTS_COLLECTION]!.unopenable).toBe(0)
  })

  it('reports rows no held generation opens, by name', async () => {
    const [older, newer] = await mintGenerations(2)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [older!, newer!],
      recipients: [recipient],
      // The older generation's roster epoch carries no wrap at all, so the
      // secret recovers the newer one alone.
      rosterWithoutWrapFor: new Set([older!.id]),
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }, { contactId: 'c-2' }],
          openedBy: [[older!]]
        }
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(sink.calls).toHaveLength(0)
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 0,
      unopenable: 2,
      unopenableCauses: { KeyUnwrapError: 2 }
    })
  })

  it('reports a chunked Resource by name and migrates the rest', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }],
          openedBy: [[generation!]],
          chunked: ['big.blob']
        }
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 1,
      unopenable: 1,
      unopenableCauses: { ChunkedResourceUnsupportedError: 1 }
    })
  })

  it('yields an all-skipped report on a re-run', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!)
    })
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink: recordingSink(() => 'skipped')
    })
    for (const collection of Object.values(report.collections)) {
      expect(collection).toMatchObject({ accepted: 0, skipped: 1 })
    }
  })

  it('counts a sink throw as a failed row and carries on', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }, { contactId: 'c-2' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const sink = recordingSink(({ index }) => {
      if (index === 0) {
        const err = new Error('the write did not land')
        err.name = 'PayloadTooLargeError'
        throw err
      }
      return 'accepted'
    })
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(sink.calls).toHaveLength(2)
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 1,
      failed: 1
    })
    expect(report.collections[CONTACTS_COLLECTION]!.stoppedBy).toBeUndefined()
  })

  it('ends a collection after ten consecutive failures and enters the next', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: Array.from({ length: 12 }, (_unused, index) => ({
            contactId: `c-${index}`
          })),
          openedBy: [[generation!]]
        },
        {
          collectionId: PRIVATE_CREDENTIALS_COLLECTION,
          rows: [{ cid: 'z-1' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const sink = recordingSink(({ collectionId }) => {
      if (collectionId === CONTACTS_COLLECTION) {
        const err = new Error('the store is down')
        err.name = 'PayloadTooLargeError'
        throw err
      }
      return 'accepted'
    })
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      failed: 10,
      stoppedBy: 'PayloadTooLargeError'
    })
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]!.accepted).toBe(1)
    expect(report.stoppedAt).toBeUndefined()
  })

  it('stops the whole walk on a quota refusal', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!)
    })
    const sink = recordingSink(({ collectionId }) => {
      if (collectionId === CONTACTS_HISTORY_COLLECTION) {
        const err = new Error('507')
        err.name = 'QuotaExceededError'
        throw err
      }
      return 'accepted'
    })
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.stoppedAt).toEqual({
      collectionId: CONTACTS_HISTORY_COLLECTION,
      cause: 'QuotaExceededError'
    })
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]).toBeUndefined()
    expect(report.collections[WALLET_ACTIVITY_COLLECTION]).toBeUndefined()
  })

  it('counts app-connections rows as not migrated and calls no sink method', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }],
          openedBy: [[generation!]]
        },
        {
          collectionId: APP_CONNECTIONS_COLLECTION,
          rows: [{ app: 'one' }, { app: 'two' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.notMigrated[APP_CONNECTIONS_COLLECTION]).toBe(2)
    expect(report.collections[APP_CONNECTIONS_COLLECTION]).toBeUndefined()
    expect(
      sink.calls.every(call => call.collectionId === CONTACTS_COLLECTION)
    ).toBe(true)
  })

  it('counts a collection whose id is a prototype member name', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: '__proto__',
          rows: [{ note: 'one' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink: recordingSink()
    })
    expect(Object.keys(report.notMigrated)).toEqual(['__proto__'])
    expect(report.notMigrated['__proto__']).toBe(1)
  })

  it('reports an unreadable collection log and carries on', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }],
          openedBy: [[generation!]],
          log: 'broken'
        },
        {
          collectionId: PRIVATE_CREDENTIALS_COLLECTION,
          rows: [{ cid: 'z-1' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 0,
      unopenable: 1,
      unopenableCauses: { CollectionLogUnreadableError: 1 },
      stoppedBy: 'CollectionLogUnreadableError'
    })
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]!.accepted).toBe(1)
  })

  it('aborts between rows with the signal reason', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: [
        {
          collectionId: CONTACTS_COLLECTION,
          rows: [{ contactId: 'c-1' }, { contactId: 'c-2' }],
          openedBy: [[generation!]]
        }
      ]
    })
    const controller = new AbortController()
    const reason = new Error('the user cancelled the import')
    const sink = recordingSink(() => {
      controller.abort(reason)
      return 'accepted'
    })
    await expect(
      migrateBundle({
        bundle,
        secret: { recoveryCode: code },
        sink,
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(sink.calls).toHaveLength(1)
  })

  it('reports progress per row', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!)
    })
    const progress = vi.fn()
    await migrateBundle({
      bundle,
      secret: { recoveryCode: code } satisfies MigrationSecret,
      sink: recordingSink(),
      onProgress: progress
    })
    expect(progress).toHaveBeenCalledTimes(4)
    expect(progress).toHaveBeenCalledWith({
      collectionId: CONTACTS_COLLECTION,
      index: 0,
      outcome: 'accepted'
    })
  })

  it('refuses the whole bundle when the user key roster log is unreadable', async () => {
    const { code } = await recoverySecret()
    const bundle = await buildBundle({
      entries: [
        jsonFile({
          name: `.space.${FIXTURE_SPACE_ID}.json`,
          document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
        }),
        keyMapDir('garbage bytes, not a resource log')
      ]
    })
    await expect(
      migrateBundle({
        bundle,
        secret: { recoveryCode: code },
        sink: recordingSink()
      })
    ).rejects.toMatchObject({ name: 'BundleInvalidError' })
  })

  it('refuses before deriving the secret when no account Space archive is named', async () => {
    const archive = await collectBytes(
      (await packSpaceArchive({
        spaceId: FIXTURE_SPACE_ID,
        entries: [
          jsonFile({
            name: `.space.${FIXTURE_SPACE_ID}.json`,
            document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
          })
        ]
      })) as unknown as AsyncIterable<Uint8Array>
    )
    const bundle = await collectBytes(
      (await writeBundle({
        meta: FIXTURE_META,
        spaces: [
          {
            spaceId: 'zNotTheAccountSpace',
            role: BUNDLE_ROLE.unlockSpaceArchive,
            archive
          }
        ]
      })) as unknown as AsyncIterable<Uint8Array>
    )
    await expect(
      migrateBundle({
        bundle,
        secret: { passphrase: 'clearly the wrong passphrase' },
        sink: recordingSink()
      })
    ).rejects.toMatchObject({ name: 'AccountSpaceArchiveMissingError' })
  })

  it('reports a collection whose log descriptor cannot build a cipher, and migrates the rest', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const roster = await rosterDescriptor({
      generations: [generation!],
      recipients: [recipient]
    })
    const encryption = await collectionDescriptor({ openedBy: [[generation!]] })
    // A well-formed log entry whose descriptor declares no key epochs at all:
    // readable as a log, but not a descriptor any cipher can be built from, so
    // it fails with neither `CollectionLogUnreadableError` nor
    // `KeyUnwrapError`.
    const malformedLogBody = `${JSON.stringify({
      state: {
        type: EPOCH_CONFIGURATION_STATE_TYPE,
        scheme: 'edv',
        version: EDV_SCHEME_VERSION,
        currentEpoch: 'zNoSuchEpoch',
        epochs: []
      }
    })}\n`
    const bundle = await buildBundle({
      entries: [
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
              body: malformedLogBody
            }),
            ...(await encryptRows({
              collectionId: CONTACTS_COLLECTION,
              encryption,
              rows: [{ contactId: 'c-1' }]
            }))
          ]
        }),
        collectionDir({
          collectionId: PRIVATE_CREDENTIALS_COLLECTION,
          files: [
            collectionLogFile({
              collectionId: PRIVATE_CREDENTIALS_COLLECTION,
              body: logBody(encryption)
            }),
            ...(await encryptRows({
              collectionId: PRIVATE_CREDENTIALS_COLLECTION,
              encryption,
              rows: [{ cid: 'z-1' }]
            }))
          ]
        })
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 0,
      stoppedBy: 'EncryptionError'
    })
    expect(report.collections[PRIVATE_CREDENTIALS_COLLECTION]!.accepted).toBe(1)
  })

  it('migrates past a malformed percent-encoded file name in a collection directory', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const roster = await rosterDescriptor({
      generations: [generation!],
      recipients: [recipient]
    })
    const encryption = await collectionDescriptor({ openedBy: [[generation!]] })
    const bundle = await buildBundle({
      entries: [
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
            })),
            {
              name: 'r.%E0.x.json',
              bytes: new TextEncoder().encode('not a valid envelope')
            }
          ]
        })
      ]
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { recoveryCode: code },
      sink
    })
    expect(report.collections[CONTACTS_COLLECTION]).toMatchObject({
      accepted: 1,
      unopenable: 0
    })
  })
  describe('app collections', () => {
    const generator = {
      id: 'did:key:z6MkApp',
      origin: 'https://app.example',
      url: 'https://app.example/',
      name: 'Example App'
    }

    it('migrates an encrypted app collection, ensuring it with its generator before any row', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          {
            collectionId: 'notes',
            rows: [{ note: 'one' }, { note: 'two' }],
            openedBy: [[generation!]],
            metadata: {
              id: 'notes',
              generator,
              _generation: 'g-1',
              _version: 4
            }
          }
        ]
      })
      expect(sink.events).toEqual(['ensure:notes', 'row:notes', 'row:notes'])
      expect(sink.ensured).toEqual([
        { collectionId: 'notes', encrypted: true, generator }
      ])
      expect(sink.calls.map(call => call.row)).toEqual(
        expect.arrayContaining([{ note: 'one' }, { note: 'two' }])
      )
      expect(sink.appRows.map(row => row.contentType)).toEqual([
        'application/json',
        'application/json'
      ])
      expect(report.collections['notes']).toEqual(tally({ accepted: 2 }))
      expect(report.notMigrated['notes']).toBeUndefined()
    })

    it('migrates a public plaintext app collection with its archived resource ids', async () => {
      const { sink, report } = await runApp({
        collections: () => [
          {
            collectionId: 'public-posts',
            rows: [{ post: 'hello' }],
            openedBy: [],
            plaintext: true,
            chunked: ['video.bin'],
            metadata: { id: 'public-posts', generator },
            extraFiles: [
              textFile('r.broken.application%2Fjson.json', 'not json'),
              policyFile(JSON.stringify({ type: 'PublicCanRead' }))
            ]
          }
        ]
      })
      expect(sink.ensured).toEqual([
        {
          collectionId: 'public-posts',
          encrypted: false,
          isPublic: true,
          generator
        }
      ])
      expect(sink.appRows).toEqual([
        {
          collectionId: 'public-posts',
          resourceId: 'row-0',
          contentType: 'application/json',
          row: { post: 'hello' }
        }
      ])
      expect(report.collections['public-posts']).toEqual(
        tally({
          accepted: 1,
          unopenable: 2,
          unopenableCauses: {
            ChunkedResourceUnsupportedError: 1,
            SyntaxError: 1
          }
        })
      )
      expect(report.notMigrated['public-posts']).toBeUndefined()
    })

    it('hands a plaintext non-JSON resource on as its bytes, and parses any +json type', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const { sink, report } = await runApp({
        collections: () => [
          {
            collectionId: 'public-posts',
            rows: [],
            openedBy: [],
            plaintext: true,
            extraFiles: [
              {
                name: fileNameFor({
                  resourceId: 'logo',
                  contentType: 'image/png'
                }),
                bytes: png
              },
              textFile(
                fileNameFor({
                  resourceId: 'answer',
                  contentType: 'text/plain'
                }),
                '42'
              ),
              textFile(
                fileNameFor({
                  resourceId: 'profile',
                  contentType: 'application/ld+json'
                }),
                '{"name":"x"}'
              )
            ]
          }
        ]
      })
      const byId = new Map(sink.appRows.map(row => [row.resourceId, row]))
      expect(byId.get('logo')).toEqual({
        collectionId: 'public-posts',
        resourceId: 'logo',
        contentType: 'image/png',
        bytes: png
      })
      expect(byId.get('answer')).toEqual({
        collectionId: 'public-posts',
        resourceId: 'answer',
        contentType: 'text/plain',
        bytes: new TextEncoder().encode('42')
      })
      expect(byId.get('profile')).toEqual({
        collectionId: 'public-posts',
        resourceId: 'profile',
        contentType: 'application/ld+json',
        row: { name: 'x' }
      })
      expect(report.collections['public-posts']).toMatchObject({
        accepted: 3,
        unopenable: 0
      })
    })

    it('refuses an app collection whose metadata declares encryption but whose log is missing', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          {
            collectionId: 'notes',
            rows: [{ note: 'one' }],
            openedBy: [[generation!]],
            log: 'omit',
            metadata: {
              id: 'notes',
              encryption: { scheme: 'edv', version: EDV_SCHEME_VERSION }
            }
          }
        ]
      })
      expect(sink.events).toEqual([])
      expect(report.collections['notes']).toEqual(
        tally({
          unopenable: 1,
          unopenableCauses: { CollectionLogUnreadableError: 1 },
          stoppedBy: 'CollectionLogUnreadableError'
        })
      )
    })

    it('refuses a log-less app collection whose metadata does not parse', async () => {
      const { sink, report } = await runApp({
        collections: () => [
          {
            collectionId: 'posts',
            rows: [{ post: 'a' }],
            openedBy: [],
            plaintext: true,
            metadataFile: 'broken'
          }
        ]
      })
      expect(sink.events).toEqual([])
      expect(sink.ensured).toEqual([])
      expect(report.collections['posts']).toEqual(
        tally({
          unopenable: 1,
          unopenableCauses: { CollectionLogUnreadableError: 1 },
          stoppedBy: 'CollectionLogUnreadableError'
        })
      )
    })

    it('refuses a log-less app collection with no metadata file', async () => {
      const { sink, report } = await runApp({
        collections: () => [
          {
            collectionId: 'posts',
            rows: [{ post: 'a' }],
            openedBy: [],
            plaintext: true,
            metadataFile: 'omit'
          }
        ]
      })
      expect(sink.events).toEqual([])
      expect(sink.ensured).toEqual([])
      expect(report.collections['posts']).toEqual(
        tally({
          unopenable: 1,
          unopenableCauses: { CollectionLogUnreadableError: 1 },
          stoppedBy: 'CollectionLogUnreadableError'
        })
      )
    })

    it('migrates a log-less app collection as plaintext when its metadata declares no encryption', async () => {
      const { sink, report } = await runApp({
        collections: () => [
          {
            collectionId: 'posts',
            rows: [{ post: 'a' }],
            openedBy: [],
            plaintext: true,
            metadata: { id: 'posts', custom: { theme: 'dark' } }
          }
        ]
      })
      expect(sink.ensured).toEqual([
        { collectionId: 'posts', encrypted: false, custom: { theme: 'dark' } }
      ])
      expect(sink.appRows).toEqual([
        {
          collectionId: 'posts',
          resourceId: 'row-0',
          contentType: 'application/json',
          row: { post: 'a' }
        }
      ])
      expect(report.collections['posts']).toEqual(tally({ accepted: 1 }))
    })

    it('ensures no further app collection after an abort between collections', async () => {
      const generations = await mintGenerations(1)
      const { code, recipient } = await recoverySecret()
      const bundle = await fixtureBundle({
        generations,
        recipients: [recipient],
        // app-a's row is the archive's last entry, so walkCollection finds no
        // entry after it to check the signal on.
        collections: [
          {
            collectionId: 'app-b',
            rows: [{ post: 'b' }],
            openedBy: [],
            plaintext: true
          },
          {
            collectionId: 'app-a',
            rows: [{ post: 'a' }],
            openedBy: [],
            plaintext: true
          }
        ]
      })
      const controller = new AbortController()
      const reason = new Error('the user cancelled the import')
      const sink = appRecordingSink({
        answer: ({ collectionId }) => {
          // The abort lands with app-a's last row.
          if (collectionId === 'app-a') {
            controller.abort(reason)
          }
          return 'accepted'
        }
      })
      await expect(
        migrateBundle({
          bundle,
          secret: { recoveryCode: code },
          sink,
          signal: controller.signal
        })
      ).rejects.toBe(reason)
      expect(sink.events).toEqual(['ensure:app-a', 'row:app-a'])
    })

    it('hands no isPublic when the collection policy grants no public read', async () => {
      const { sink } = await runApp({
        collections: () => [
          {
            collectionId: 'plain-a',
            rows: [{ post: 'a' }],
            openedBy: [],
            plaintext: true
          },
          {
            collectionId: 'plain-b',
            rows: [{ post: 'b' }],
            openedBy: [],
            plaintext: true,
            extraFiles: [policyFile(JSON.stringify({ type: 'SomethingElse' }))]
          },
          {
            collectionId: 'plain-c',
            rows: [{ post: 'c' }],
            openedBy: [],
            plaintext: true,
            extraFiles: [policyFile('not json')]
          }
        ]
      })
      expect(sink.ensured).toEqual([
        { collectionId: 'plain-a', encrypted: false },
        { collectionId: 'plain-b', encrypted: false },
        { collectionId: 'plain-c', encrypted: false }
      ])
    })

    it('hands no generator when the Collection Metadata names none or does not parse', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          {
            collectionId: 'app-a',
            rows: [{ note: 'a' }],
            openedBy: [[generation!]]
          },
          {
            collectionId: 'app-b',
            rows: [{ note: 'b' }],
            openedBy: [[generation!]],
            metadata: 'not an object'
          },
          {
            collectionId: 'app-c',
            rows: [{ note: 'c' }],
            openedBy: [[generation!]],
            metadata: { id: 'app-c', generator: { origin: 'no id' } }
          }
        ]
      })
      expect(sink.ensured).toEqual([
        { collectionId: 'app-a', encrypted: true },
        { collectionId: 'app-b', encrypted: true },
        { collectionId: 'app-c', encrypted: true }
      ])
      expect(report.collections['app-b']!.accepted).toBe(1)
    })

    const indexSchema: IndexSchema = {
      revision: 1,
      indexes: [{ attribute: 'content.type', addedIn: 1 }]
    }

    it('hands the sealed index schema to ensureCollection, falling back to an older generation', async () => {
      const { sink, report } = await runApp({
        generationCount: 2,
        collections: ([older, newer]) => [
          {
            collectionId: 'notes',
            rows: [{ note: 'one' }],
            // The schema was sealed under the first epoch, which the newest
            // generation cannot unwrap, so the older one opens it.
            openedBy: [[older!], [older!, newer!]],
            hmacFor: [older!, newer!],
            sealedIndexSchema: {
              schema: indexSchema,
              by: older!,
              underFirstEpoch: true
            }
          }
        ]
      })
      expect(sink.ensured).toEqual([
        { collectionId: 'notes', encrypted: true, indexSchema }
      ])
      expect(report.collections['notes']!.accepted).toBe(1)
    })

    it('hands no index schema when the sealed custom will not open, and migrates the rows', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          {
            collectionId: 'notes',
            rows: [{ note: 'one' }],
            openedBy: [[generation!]],
            hmacFor: [generation!],
            // Sealed for another collection, so the id binding refuses it.
            sealedIndexSchema: {
              schema: indexSchema,
              by: generation!,
              boundTo: 'elsewhere'
            }
          },
          {
            collectionId: 'plain-custom',
            rows: [{ note: 'two' }],
            openedBy: [[generation!]],
            hmacFor: [generation!],
            metadata: { id: 'plain-custom', custom: { not: 'an envelope' } }
          },
          {
            collectionId: 'no-custom',
            rows: [{ note: 'three' }],
            openedBy: [[generation!]],
            hmacFor: [generation!]
          }
        ]
      })
      expect(sink.ensured).toEqual([
        { collectionId: 'no-custom', encrypted: true },
        { collectionId: 'notes', encrypted: true },
        { collectionId: 'plain-custom', encrypted: true }
      ])
      expect(report.collections['notes']!.accepted).toBe(1)
      expect(report.collections['plain-custom']!.accepted).toBe(1)
      expect(report.collections['no-custom']!.accepted).toBe(1)
    })

    it('walks the app collections by id after credentials, with activity last', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          ...standardCollections(generation!),
          {
            collectionId: 'zeta',
            rows: [{ note: 'z' }],
            openedBy: [],
            plaintext: true
          },
          {
            collectionId: 'alpha',
            rows: [{ note: 'a' }],
            openedBy: [[generation!]]
          }
        ]
      })
      const walkOrder = [
        CONTACTS_COLLECTION,
        CONTACTS_HISTORY_COLLECTION,
        PRIVATE_CREDENTIALS_COLLECTION,
        'alpha',
        'zeta',
        WALLET_ACTIVITY_COLLECTION
      ]
      expect(sink.calls.map(call => call.collectionId)).toEqual(walkOrder)
      expect(Object.keys(report.collections)).toEqual(walkOrder)
    })

    it('counts app collections as not migrated when the sink carries no appCollections', async () => {
      const [generation] = await mintGenerations(1)
      const { code, recipient } = await recoverySecret()
      const bundle = await fixtureBundle({
        generations: [generation!],
        recipients: [recipient],
        collections: [
          {
            collectionId: 'notes',
            rows: [{ note: 'one' }, { note: 'two' }],
            openedBy: [[generation!]]
          },
          {
            collectionId: 'public-posts',
            rows: [{ post: 'hello' }],
            openedBy: [],
            plaintext: true
          }
        ]
      })
      const sink = recordingSink()
      const report = await migrateBundle({
        bundle,
        secret: { recoveryCode: code },
        sink
      })
      expect(sink.calls).toHaveLength(0)
      expect(report.notMigrated['notes']).toBe(2)
      expect(report.notMigrated['public-posts']).toBe(1)
      expect(report.collections['notes']).toBeUndefined()
    })

    it('leaves app-connections unmigrated with an app-collections sink', async () => {
      const { sink, report } = await runApp({
        collections: ([generation]) => [
          {
            collectionId: APP_CONNECTIONS_COLLECTION,
            rows: [{ app: 'one' }],
            openedBy: [[generation!]]
          }
        ]
      })
      expect(sink.events).toEqual([])
      expect(report.notMigrated[APP_CONNECTIONS_COLLECTION]).toBe(1)
    })

    it('stops just the app collection whose ensureCollection throws', async () => {
      const { sink, report } = await runApp({
        sink: appRecordingSink({
          ensure: collectionId => {
            if (collectionId === 'app-a') {
              const err = new Error('the collection could not be created')
              err.name = 'CollectionCreateError'
              throw err
            }
          }
        }),
        collections: ([generation]) => [
          {
            collectionId: 'app-a',
            rows: [{ note: 'a' }],
            openedBy: [[generation!]]
          },
          {
            collectionId: 'app-b',
            rows: [{ note: 'b' }],
            openedBy: [[generation!]]
          }
        ]
      })
      expect(sink.events).toEqual(['ensure:app-a', 'ensure:app-b', 'row:app-b'])
      expect(report.collections['app-a']).toEqual(
        tally({
          unopenable: 1,
          unopenableCauses: { CollectionCreateError: 1 },
          stoppedBy: 'CollectionCreateError'
        })
      )
      expect(report.collections['app-b']!.accepted).toBe(1)
      expect(report.stoppedAt).toBeUndefined()
    })

    it('stops the whole walk on a quota refusal from ensureCollection', async () => {
      const { report } = await runApp({
        sink: appRecordingSink({
          ensure: () => {
            const err = new Error('507')
            err.name = 'QuotaExceededError'
            throw err
          }
        }),
        collections: ([generation]) => [
          ...standardCollections(generation!),
          {
            collectionId: 'app-a',
            rows: [{ note: 'a' }],
            openedBy: [[generation!]]
          }
        ]
      })
      expect(report.stoppedAt).toEqual({
        collectionId: 'app-a',
        cause: 'QuotaExceededError'
      })
      expect(report.collections['app-a']!.stoppedBy).toBe('QuotaExceededError')
      expect(report.collections[WALLET_ACTIVITY_COLLECTION]).toBeUndefined()
    })
  })
})
