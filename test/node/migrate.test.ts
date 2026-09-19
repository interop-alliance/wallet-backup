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
import { collectBytes, packSpaceArchive } from '@interop/space-archive'
import {
  migrateBundle,
  packRecoveryCode,
  writeBundle,
  BUNDLE_ROLE
} from '../../src/index.js'
import type {
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
 * Assembles a fixture bundle: a user key roster wrapped to the given
 * recipients, then one archive directory per collection.
 *
 * @param options {object}
 * @param options.generations {Generation[]}   oldest first
 * @param options.recipients {RecipientPublicKey[]}
 * @param options.collections {FixtureCollection[]}
 * @param [options.rosterWithoutWrapFor] {ReadonlySet<string>}
 * @param [options.recoveryCode] {unknown}   the packed code document
 * @returns {Promise<Uint8Array>}
 */
async function fixtureBundle({
  generations,
  recipients,
  collections,
  rosterWithoutWrapFor,
  recoveryCode
}: {
  generations: Generation[]
  recipients: RecipientPublicKey[]
  collections: FixtureCollection[]
  rosterWithoutWrapFor?: ReadonlySet<string>
  recoveryCode?: unknown
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
    const encryption = await collectionDescriptor({
      openedBy: collection.openedBy
    })
    const files = await encryptRows({
      collectionId: collection.collectionId,
      encryption,
      rows: collection.rows
    })
    const log = collection.log ?? 'wrapped'
    entries.push(
      collectionDir({
        collectionId: collection.collectionId,
        files: [
          ...(log === 'omit'
            ? []
            : [
                collectionLogFile({
                  collectionId: collection.collectionId,
                  body: log === 'broken' ? 'not a log' : logBody(encryption)
                })
              ]),
          ...files,
          ...(collection.chunked ?? []).map(chunkDir)
        ]
      })
    )
  }
  return buildBundle({
    entries,
    ...(recoveryCode !== undefined && { recoveryCode })
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

  it('opens the bundle with a plain packed recovery code', async () => {
    const [generation] = await mintGenerations(1)
    const { code, recipient } = await recoverySecret()
    const bundle = await fixtureBundle({
      generations: [generation!],
      recipients: [recipient],
      collections: standardCollections(generation!),
      recoveryCode: await packRecoveryCode({ code })
    })
    const sink = recordingSink()
    const report = await migrateBundle({
      bundle,
      secret: { packedCode: {} },
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
})
