/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One pass over the account Space archive that gathers everything small the
 * walk needs before it opens a row: the user key roster log, each migrated
 * collection's governing log, which Resources are stored in chunks, and how
 * many rows sit in the collections the walk carries no import function for.
 *
 * The survey buffers only those small documents. The rows themselves are read
 * in a later pass per collection, one at a time, so a whole collection is
 * never in memory even though the archive is walked more than once.
 */
import {
  KEY_MAP_COLLECTION,
  USER_KEY_ROSTER_LOG_RESOURCE
} from '@interop/wallet-core/space'
import {
  classifyCollectionFile,
  parseArchivePath,
  readSpaceArchive
} from '@interop/space-archive'
import type { ByteSource } from '@interop/space-archive'

/**
 * What one pass over the archive found.
 */
export interface ArchiveSurvey {
  /** the user key roster resource's bytes, its JSON Lines body verbatim */
  rosterLog?: Uint8Array
  /** each migrated collection's `.collectionlog.<id>.json` bytes, by id */
  collectionLogs: Map<string, Uint8Array>
  /** the chunk-stored Resource ids of each migrated collection, by id */
  chunked: Map<string, Set<string>>
  /** the migrated collections the archive carries a directory for */
  present: Set<string>
  /** the row count of each collection the walk does not migrate, by id */
  notMigrated: Map<string, number>
}

/**
 * Walks the archive once and gathers the survey.
 *
 * @param options {object}
 * @param options.archive {ByteSource}   the account Space archive's bytes
 * @param options.migrated {ReadonlySet<string>}   the collection ids the walk
 *   migrates; every other collection's rows are counted, not read
 * @returns {Promise<ArchiveSurvey>}
 */
export async function surveyArchive({
  archive,
  migrated
}: {
  archive: ByteSource
  migrated: ReadonlySet<string>
}): Promise<ArchiveSurvey> {
  const survey: ArchiveSurvey = {
    collectionLogs: new Map(),
    chunked: new Map(),
    present: new Set(),
    notMigrated: new Map()
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
    if (entry.type !== 'file') {
      continue
    }
    const file = classifyCollectionFile(position.fileName)
    if (file.kind === 'collectionLog' && migrated.has(collectionId)) {
      survey.collectionLogs.set(collectionId, await entry.bytes())
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
    if (!migrated.has(collectionId)) {
      survey.notMigrated.set(
        collectionId,
        (survey.notMigrated.get(collectionId) ?? 0) + 1
      )
    }
  }
  return survey
}
