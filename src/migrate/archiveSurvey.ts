/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One pass over the account Space archive that gathers everything small the
 * walk needs before it opens a row: the user key roster log, each migrated
 * collection's governing log, which Resources are stored in chunks, each app
 * collection's `generator`, metadata `custom`, declared `encryption`, and
 * public-read policy, and how many rows sit in the collections the walk
 * carries no import function for.
 *
 * The survey buffers only those small documents. The rows themselves are read
 * in a later pass per collection, one at a time, so a whole collection is
 * never in memory even though the archive is walked more than once.
 */
import {
  KEY_MAP_COLLECTION,
  USER_KEY_ROSTER_LOG_RESOURCE,
  WALLET_SPACE_PROVISION_ROSTER
} from '@interop/wallet-core/space/collections'
import {
  classifyCollectionFile,
  collectionGeneratorFromMetadata,
  collectionMetadataFromFile,
  parseArchivePath,
  policyFromFile,
  readSpaceArchive
} from '@interop/space-archive'
import type { ByteSource } from '@interop/space-archive'
import type { CollectionGenerator } from '@interop/was-client'

/**
 * The collection ids of the wallet Space's own layout: the synced standard
 * collections and the system collections. Every other collection in the
 * account Space archive is an app collection, encrypted or plaintext.
 */
const WALLET_LAYOUT_COLLECTIONS: ReadonlySet<string> = new Set(
  WALLET_SPACE_PROVISION_ROSTER.map(spec => spec.collectionId)
)

/**
 * What the survey found about one migrated app collection.
 */
export interface AppCollectionSurvey {
  /**
   * whether the collection is client-side encrypted. It is plaintext only when
   * its archived metadata file exists, parses, and declares no `encryption`,
   * and it carries no governing log.
   */
  encrypted: boolean
  /** whether its archived collection policy is `PublicCanRead` */
  isPublic: boolean
  /** the `generator` its archived metadata names */
  generator?: CollectionGenerator
  /** its archived metadata `custom` value */
  custom?: unknown
}

/**
 * What one pass over the archive found.
 */
export interface ArchiveSurvey {
  /** the user key roster resource's bytes, its JSON Lines body verbatim */
  rosterLog?: Uint8Array
  /** each migrated collection's `.collectionlog.<id>.json` bytes, by id */
  collectionLogs: Map<string, Uint8Array>
  /** the chunk-stored Resource ids of each collection, by id */
  chunked: Map<string, Set<string>>
  /** the migrated standard collections the archive carries a directory for */
  present: Set<string>
  /**
   * the app collections the walk migrates, by id in sorted order; empty when
   * it migrates none
   */
  appCollections: Map<string, AppCollectionSurvey>
  /** the row count of each collection the walk reads, by id */
  walkedRows: Map<string, number>
  /** the row count of each collection the walk does not migrate, by id */
  notMigrated: Map<string, number>
}

/**
 * Walks the archive once and gathers the survey.
 *
 * @param options {object}
 * @param options.archive {ByteSource}   the account Space archive's bytes
 * @param options.migrated {ReadonlySet<string>}   the standard collection ids
 *   the walk migrates
 * @param options.migratesAppCollections {boolean}   whether the walk migrates
 *   app collections; when it does not, their rows are counted as not migrated
 * @returns {Promise<ArchiveSurvey>}
 */
export async function surveyArchive({
  archive,
  migrated,
  migratesAppCollections
}: {
  archive: ByteSource
  migrated: ReadonlySet<string>
  migratesAppCollections: boolean
}): Promise<ArchiveSurvey> {
  const survey: ArchiveSurvey = {
    collectionLogs: new Map(),
    chunked: new Map(),
    present: new Set(),
    appCollections: new Map(),
    walkedRows: new Map(),
    notMigrated: new Map()
  }
  const appCollections = new Map<string, AppCollectionSurvey>()

  /**
   * Whether the walk reads this collection's rows rather than counting them.
   * @param collectionId {string}
   * @returns {boolean}
   */
  function isWalked(collectionId: string): boolean {
    return migrated.has(collectionId) || appCollections.has(collectionId)
  }

  const opened = await readSpaceArchive(archive)
  for await (const entry of opened.entries) {
    const position = parseArchivePath(entry.name)
    if (position.area === 'chunk') {
      const ids = survey.chunked.get(position.collectionId) ?? new Set<string>()
      ids.add(position.resourceId)
      survey.chunked.set(position.collectionId, ids)
      continue
    }
    if (position.area !== 'collection') {
      continue
    }
    const { collectionId } = position
    if (migrated.has(collectionId)) {
      survey.present.add(collectionId)
    }
    if (
      migratesAppCollections &&
      !WALLET_LAYOUT_COLLECTIONS.has(collectionId) &&
      !appCollections.has(collectionId)
    ) {
      // The walk fails closed: a collection counts as encrypted until its
      // metadata parses and declares no `encryption`.
      appCollections.set(collectionId, { encrypted: true, isPublic: false })
    }
    if (entry.type !== 'file') {
      continue
    }
    const file = classifyCollectionFile(position.fileName)
    if (file.kind === 'collectionLog' && isWalked(collectionId)) {
      survey.collectionLogs.set(collectionId, await entry.bytes())
      continue
    }
    const app = appCollections.get(collectionId)
    if (file.kind === 'collectionMetadata' && app !== undefined) {
      let metadata: Record<string, unknown>
      try {
        metadata = collectionMetadataFromFile({ bytes: await entry.bytes() })
      } catch {
        // A metadata file that does not parse carries nothing the walk hands
        // on. It cannot show the collection is plaintext, so the collection
        // stays encrypted.
        continue
      }
      const generator = collectionGeneratorFromMetadata(metadata)
      if (generator !== undefined) {
        app.generator = generator
      }
      if (metadata.custom !== undefined) {
        app.custom = metadata.custom
      }
      app.encrypted = metadata.encryption !== undefined
      continue
    }
    if (
      file.kind === 'policy' &&
      file.scope === 'collection' &&
      app !== undefined
    ) {
      try {
        app.isPublic =
          policyFromFile({ bytes: await entry.bytes() }).type ===
          'PublicCanRead'
      } catch {
        // A policy file that does not parse grants nothing.
      }
      continue
    }
    if (file.kind !== 'representation') {
      continue
    }
    if (
      collectionId === KEY_MAP_COLLECTION.id &&
      file.resourceId === USER_KEY_ROSTER_LOG_RESOURCE
    ) {
      survey.rosterLog = await entry.bytes()
      continue
    }
    const counts = isWalked(collectionId)
      ? survey.walkedRows
      : survey.notMigrated
    counts.set(collectionId, (counts.get(collectionId) ?? 0) + 1)
  }
  for (const collectionId of [...appCollections.keys()].sort()) {
    const app = appCollections.get(collectionId)!
    // A governing log makes a collection encrypted whatever its metadata
    // says. A missing or unparseable metadata file left it encrypted too, so
    // a lost log is refused rather than its envelopes handed on as plaintext.
    if (survey.collectionLogs.has(collectionId)) {
      app.encrypted = true
    }
    survey.appCollections.set(collectionId, app)
  }
  return survey
}
