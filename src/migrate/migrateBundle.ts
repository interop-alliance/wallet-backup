/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The content-migration walk: a backup bundle and one old secret in, plaintext
 * rows pushed at a host's sink, and a report of what happened out.
 *
 * The walk issues no request. Everything it needs is in the bundle -- the user
 * key roster, each collection's encryption descriptor, every envelope -- so a
 * migration runs from the file alone, against any server, with the old account
 * long gone. Nothing in the path names an account DID, which is what makes a
 * bundle portable between accounts at all.
 *
 * It refuses early or not at all. A bundle that cannot be opened, an archive
 * with no account Space, or a secret that is a recipient of nothing fails
 * before a single row reaches the sink. Past that point every failure is a
 * count in the report: a collection whose log will not read, a row no held
 * generation opens, a write the sink could not land. The one exception is the
 * server's quota refusal, which ends the walk, since every later row would hit
 * the same wall.
 *
 * Key material lives no longer than the walk, as far as it can be scrubbed.
 * The `finally` below zeroes every generation's raw secret and the derived
 * seed whether the walk ended, was aborted, or threw. The key objects built
 * from them carry their private half as an immutable string, which nothing can
 * overwrite in place; those are dropped here and reclaimed by garbage
 * collection rather than wiped.
 */
import { accountSpaceArchive, readBundle } from '../bundle/readBundle.js'
import { bundleManifestSummary } from '../bundle/manifest.js'
import { BundleInvalidError, CollectionLogUnreadableError } from '../errors.js'
import type { ByteSource } from '@interop/space-archive'
import { surveyArchive } from './archiveSurvey.js'
import { walkCollection } from './collectionWalk.js'
import {
  descriptorFromCollectionLogFile,
  descriptorFromLogBody
} from './descriptorLog.js'
import {
  ciphersForCollection,
  recoverGenerations,
  zeroGenerations
} from './generations.js'
import type { UserKeyGeneration } from './generations.js'
import { CollectionTally, keyedRecord } from './report.js'
import type { MigrationCollectionReport, MigrationReport } from './report.js'
import { recipientFromSecret } from './secretToRecipient.js'
import type { MigrationSecret } from './secretToRecipient.js'
import { MIGRATION_WALK_ORDER } from './sink.js'
import type { MigrationSink, SinkOutcome } from './sink.js'

/**
 * Migrates a backup bundle's content into a host's stores.
 *
 * @param options {object}
 * @param options.bundle {ByteSource}   the outer bundle tar's bytes, or a
 *   stream of them
 * @param options.secret {MigrationSecret}   the old account's unlock
 *   passphrase, its recovery code, or the backup credential the bundle carries
 * @param options.sink {MigrationSink}   the host's import functions
 * @param [options.signal] {AbortSignal}   checked between rows; the walk
 *   throws its `reason`
 * @param [options.onProgress] {function}   called once per row with
 *   `{ collectionId, index, outcome }`
 * @returns {Promise<MigrationReport>}
 */
export async function migrateBundle({
  bundle,
  secret,
  sink,
  signal,
  onProgress
}: {
  bundle: ByteSource
  secret: MigrationSecret
  sink: MigrationSink
  signal?: AbortSignal
  onProgress?: (options: {
    collectionId: string
    index: number
    outcome: SinkOutcome | 'unopenable'
  }) => void
}): Promise<MigrationReport> {
  const opened = await readBundle(bundle)
  const manifest = bundleManifestSummary(opened.manifest)
  let archive: Uint8Array
  try {
    archive = await accountSpaceArchive(opened)
  } finally {
    await opened.close()
  }

  // The structural refusals come first: they cost one pass over the archive,
  // where deriving the recipient from a passphrase costs an Argon2id run.
  const migrated = new Set(
    MIGRATION_WALK_ORDER.map(entry => entry.collectionId)
  )
  const survey = await surveyArchive({ archive, migrated })
  if (survey.rosterLog === undefined) {
    throw new BundleInvalidError(
      'The account Space archive carries no user key roster resource, so no ' +
        'secret can open anything in this bundle.'
    )
  }
  let rosterDescriptor
  try {
    rosterDescriptor = descriptorFromLogBody({
      body: new TextDecoder().decode(survey.rosterLog),
      label: 'user key roster log'
    })
  } catch (err) {
    // An unreadable roster log refuses the whole bundle, so it carries the
    // bundle's refusal name rather than the per-collection one.
    throw new BundleInvalidError(
      'The user key roster log in the account Space archive cannot be read, ' +
        'so no secret can open anything in this bundle.',
      { cause: err }
    )
  }

  let recipient: Awaited<ReturnType<typeof recipientFromSecret>> | undefined
  let generations: UserKeyGeneration[] = []
  const collections = new Map<string, MigrationCollectionReport>()
  let stoppedAt: MigrationReport['stoppedAt']
  try {
    recipient = await recipientFromSecret({
      secret,
      files: opened.files
    })
    generations = await recoverGenerations({
      descriptor: rosterDescriptor,
      keyAgreementKey: recipient.keyAgreementKey
    })

    for (const { collectionId, method } of MIGRATION_WALK_ORDER) {
      if (!survey.present.has(collectionId)) {
        // A collection the archive does not carry was never entered, so it is
        // absent from the report rather than present with zeroes.
        continue
      }
      const tally = new CollectionTally()
      const logBytes = survey.collectionLogs.get(collectionId)
      let ciphers
      try {
        if (logBytes === undefined) {
          throw new CollectionLogUnreadableError(
            `The archived collection "${collectionId}" carries no governing ` +
              'history log, so its encryption descriptor is unknown.'
          )
        }
        ciphers = await ciphersForCollection({
          generations,
          collectionId,
          encryption: descriptorFromCollectionLogFile({
            bytes: logBytes,
            collectionId
          })
        })
      } catch (err) {
        // Rows have already reached the sink by now, so nothing here may end
        // the walk without a report. An unreadable log is the expected cause;
        // any other (a descriptor body no cipher can be built from) is named
        // as it came.
        tally.stoppedBy = (err as Error).name
        collections.set(collectionId, tally.toReport())
        continue
      }
      const { stopped } = await walkCollection({
        archive,
        collectionId,
        method,
        sink,
        ciphers,
        chunked: survey.chunked.get(collectionId) ?? new Set(),
        tally,
        signal,
        onProgress
      })
      collections.set(collectionId, tally.toReport())
      if (stopped !== undefined) {
        stoppedAt = { collectionId, cause: stopped }
        break
      }
    }
  } finally {
    zeroGenerations(generations)
    recipient?.unlockSeed?.fill(0)
  }

  const report: MigrationReport = {
    manifest,
    collections: keyedRecord(collections),
    notMigrated: keyedRecord(survey.notMigrated)
  }
  if (stoppedAt !== undefined) {
    report.stoppedAt = stoppedAt
  }
  return report
}
