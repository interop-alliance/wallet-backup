/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Builds migration fixtures offline: a user key roster with as many
 * generations as a test wants, one epoch roster per collection wrapped to
 * whichever generations that test wants to open it, real envelopes over the
 * real cipher, and the whole thing packed by this package's own archive and
 * bundle writers.
 *
 * Nothing here talks to a server. The roster and the collection descriptors
 * are assembled from was-client's epoch primitives directly, so a test can
 * produce states the live ceremonies would not -- a torn cascade, a generation
 * whose wrap went missing -- which is exactly what the walk has to survive.
 */
import {
  createEdvEncryptOnlyDocCipher,
  mintEpoch,
  ownerRecipient,
  toEpochConfigurationState,
  wrapEpochSecret,
  EDV_SCHEME_VERSION
} from '@interop/was-client/edv/core'
import type { RecipientPublicKey } from '@interop/was-client/edv/core'
import type { CollectionEncryption } from '@interop/was-client'
import { mintUserKey } from '@interop/wallet-core/keys/userKey'
import { userKeyAsRecipient } from '@interop/wallet-core/keys/userKeyGenerations'
import {
  KEY_MAP_COLLECTION,
  USER_KEY_ROSTER_LOG_RESOURCE
} from '@interop/wallet-core/space/collections'
import {
  chunkDirName,
  collectBytes,
  fileNameFor,
  packSpaceArchive
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'
import { writeBundle, BUNDLE_ROLE } from '../../../src/index.js'
import type { BundleMeta } from '../../../src/index.js'

/**
 * One user key generation, as the roster carries it.
 */
export type Generation = Awaited<ReturnType<typeof mintUserKey>>

/**
 * The fixture account Space's id.
 */
export const FIXTURE_SPACE_ID = 'zMigrationSpace'

/**
 * The fixture bundle's provenance.
 */
export const FIXTURE_META: BundleMeta = {
  created: '2026-09-18T00:00:00.000Z',
  createdBy: {
    controller: 'did:webvh:zFixtureScid:example.com:space:zOld:id',
    client: { name: 'Fixture Wallet', url: 'https://example.com/' }
  }
}

/**
 * Encodes one JSON document as an archive file.
 * @param options {object}
 * @param options.name {string}
 * @param options.document {unknown}
 * @returns {ArchiveFile}
 */
export function jsonFile({
  name,
  document
}: {
  name: string
  document: unknown
}): ArchiveFile {
  return { name, bytes: new TextEncoder().encode(JSON.stringify(document)) }
}

/**
 * Mints a chain of user key generations, oldest first.
 * @param count {number}
 * @returns {Promise<Generation[]>}
 */
export async function mintGenerations(count: number): Promise<Generation[]> {
  const generations: Generation[] = []
  for (let index = 0; index < count; index += 1) {
    generations.push(await mintUserKey())
  }
  return generations
}

/**
 * Builds a user key roster descriptor: one epoch per generation, each wrapped
 * to every recipient given. A generation listed in `withoutWrapFor` gets an
 * epoch with no wrap for that recipient, which is how a fixture produces a
 * generation the secret cannot recover.
 *
 * @param options {object}
 * @param options.generations {Generation[]}   oldest first
 * @param options.recipients {RecipientPublicKey[]}   the enrolled secrets
 * @param [options.withoutWrapFor] {ReadonlySet<string>}   generation ids whose
 *   epoch carries no wrap at all
 * @returns {Promise<CollectionEncryption>}
 */
export async function rosterDescriptor({
  generations,
  recipients,
  withoutWrapFor = new Set<string>()
}: {
  generations: Generation[]
  recipients: RecipientPublicKey[]
  withoutWrapFor?: ReadonlySet<string>
}): Promise<CollectionEncryption> {
  const epochs = []
  for (const generation of generations) {
    const wraps = withoutWrapFor.has(generation.id) ? [] : recipients
    epochs.push({
      id: generation.id,
      recipients: await Promise.all(
        wraps.map(recipient =>
          wrapEpochSecret({ epochSecret: generation.secret, recipient })
        )
      )
    })
  }
  return {
    scheme: 'edv',
    version: EDV_SCHEME_VERSION,
    currentEpoch: generations[generations.length - 1]!.id,
    epochs
  }
}

/**
 * Builds a collection's epoch roster: one epoch per entry, each sealed to the
 * generations that entry names. A collection whose newest epoch is sealed to
 * an older generation alone is a torn cascade.
 *
 * @param options {object}
 * @param options.openedBy {Generation[][]}   one entry per epoch, oldest
 *   first, each naming the generations that may open it
 * @returns {Promise<CollectionEncryption>}
 */
export async function collectionDescriptor({
  openedBy
}: {
  openedBy: Generation[][]
}): Promise<CollectionEncryption> {
  const epochs = []
  for (const readers of openedBy) {
    const { epochId, secret } = await mintEpoch()
    epochs.push({
      id: epochId,
      recipients: await Promise.all(
        readers.map(userKey =>
          wrapEpochSecret({
            epochSecret: secret,
            recipient: userKeyAsRecipient({ userKey })
          })
        )
      )
    })
  }
  return {
    scheme: 'edv',
    version: EDV_SCHEME_VERSION,
    currentEpoch: epochs[epochs.length - 1]!.id,
    epochs
  }
}

/**
 * The recipient entry for a client key-agreement key (a derived secret's
 * identity), as the roster wraps to it.
 * @param keyAgreementKey {object}
 * @returns {RecipientPublicKey}
 */
export function recipientFor(keyAgreementKey: unknown): RecipientPublicKey {
  return ownerRecipient({
    keyAgreementKey: keyAgreementKey as Parameters<
      typeof ownerRecipient
    >[0]['keyAgreementKey']
  })
}

/**
 * Serializes an encryption descriptor as the one-entry JSON Lines log whose
 * head declares it.
 * @param descriptor {CollectionEncryption}
 * @returns {string}
 */
export function logBody(descriptor: CollectionEncryption): string {
  return `${JSON.stringify({
    state: toEpochConfigurationState(descriptor)
  })}\n`
}

/**
 * The archived Collection log file: the server's stored record, the JSON Lines
 * body beside the validator it was served under.
 * @param options {object}
 * @param options.collectionId {string}
 * @param options.body {string}
 * @returns {ArchiveFile}
 */
export function collectionLogFile({
  collectionId,
  body
}: {
  collectionId: string
  body: string
}): ArchiveFile {
  return jsonFile({
    name: `.collectionlog.${collectionId}.json`,
    document: { generation: 'zFixtureLogGeneration', version: 1, body }
  })
}

/**
 * Encrypts rows into a collection's archive files, under the descriptor's
 * current epoch. Each file is named with the id the cipher derived, which is
 * the id the envelope is bound to.
 *
 * @param options {object}
 * @param options.collectionId {string}
 * @param options.encryption {CollectionEncryption}
 * @param options.rows {unknown[]}
 * @returns {Promise<ArchiveFile[]>}
 */
export async function encryptRows({
  collectionId,
  encryption,
  rows
}: {
  collectionId: string
  encryption: CollectionEncryption
  rows: unknown[]
}): Promise<ArchiveFile[]> {
  const cipher = await createEdvEncryptOnlyDocCipher({
    collectionId,
    encryption
  })
  const files: ArchiveFile[] = []
  for (const row of rows) {
    const { id, envelope } = await cipher.encrypt({
      data: row as Parameters<typeof cipher.encrypt>[0]['data']
    })
    files.push(
      jsonFile({
        name: fileNameFor({ resourceId: id, contentType: 'application/json' }),
        document: envelope
      })
    )
  }
  return files
}

/**
 * One collection directory of the fixture archive.
 * @param options {object}
 * @param options.collectionId {string}
 * @param options.files {ArchiveEntry[]}   the collection's own files, after
 *   its Metadata dot-file
 * @returns {ArchiveEntry}
 */
export function collectionDir({
  collectionId,
  files
}: {
  collectionId: string
  files: ArchiveEntry[]
}): ArchiveEntry {
  return {
    name: collectionId,
    files: [
      jsonFile({
        name: `.collection.${collectionId}.json`,
        document: { id: collectionId }
      }),
      ...files
    ]
  }
}

/**
 * A chunk directory, which the walk refuses to open.
 * @param resourceId {string}
 * @returns {ArchiveEntry}
 */
export function chunkDir(resourceId: string): ArchiveEntry {
  return {
    name: chunkDirName(resourceId),
    files: [{ name: '0', bytes: new TextEncoder().encode('chunk') }]
  }
}

/**
 * The `key-map` collection directory, holding the user key roster resource.
 * @param body {string}   the roster log's JSON Lines
 * @returns {ArchiveEntry}
 */
export function keyMapDir(body: string): ArchiveEntry {
  return collectionDir({
    collectionId: KEY_MAP_COLLECTION.id,
    files: [
      {
        name: fileNameFor({
          resourceId: USER_KEY_ROSTER_LOG_RESOURCE,
          contentType: 'application/json'
        }),
        bytes: new TextEncoder().encode(body)
      }
    ]
  })
}

/**
 * Packs an account Space archive and wraps it in a bundle.
 *
 * @param options {object}
 * @param options.entries {ArchiveEntry[]}   the Space's entry tree
 * @param [options.recoveryCode] {unknown}   the packed code document
 * @returns {Promise<Uint8Array>}   the bundle's tar bytes
 */
export async function buildBundle({
  entries,
  recoveryCode
}: {
  entries: ArchiveEntry[]
  recoveryCode?: unknown
}): Promise<Uint8Array> {
  const archive = await collectBytes(
    (await packSpaceArchive({
      spaceId: FIXTURE_SPACE_ID,
      entries
    })) as unknown as AsyncIterable<Uint8Array>
  )
  const pack = await writeBundle({
    meta: FIXTURE_META,
    spaces: [
      {
        spaceId: FIXTURE_SPACE_ID,
        role: BUNDLE_ROLE.accountSpaceArchive,
        archive
      }
    ],
    ...(recoveryCode !== undefined && { recoveryCode })
  })
  return collectBytes(pack as unknown as AsyncIterable<Uint8Array>)
}
