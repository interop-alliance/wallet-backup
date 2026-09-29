/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The content-migration walk: a backup bundle and one old secret in, plaintext
 * Resources pushed at a host's sink, and a report of what happened out.
 *
 * The walk issues no request. Everything it needs is in the bundle -- the user
 * key roster, each collection's encryption descriptor, every envelope -- so a
 * migration runs from the file alone, against any server, with the old account
 * long gone. Nothing in the path names an account DID, which is what makes a
 * bundle portable between accounts at all.
 *
 * It refuses early or not at all. A bundle that cannot be opened, an archive
 * with no account Space, or a secret that is a recipient of nothing fails
 * before a single Resource reaches the sink. Past that point every failure is a
 * count in the report: a collection whose log will not read, a Resource no held
 * generation opens, a write the sink could not land. The one exception is the
 * server's quota refusal, which ends the walk, since every later Resource would
 * hit the same wall.
 *
 * Key material lives no longer than the walk, as far as it can be scrubbed.
 * The `finally` below zeroes every generation's raw secret and the derived
 * seed whether the walk ended, was aborted, or threw. The key objects built
 * from them carry their private half as an immutable string, which nothing can
 * overwrite in place; those are dropped here and reclaimed by garbage
 * collection rather than wiped.
 */
import { WALLET_ACTIVITY_COLLECTION } from '@interop/wallet-core/space/collections'
import type { EdvDocCipher } from '@interop/was-client/edv/core'
import { accountSpaceArchive, readBundle } from '../bundle/readBundle.js'
import { bundleManifestSummary } from '../bundle/manifest.js'
import { BundleInvalidError, CollectionLogUnreadableError } from '../errors.js'
import type { ByteSource } from '@interop/space-archive'
import { surveyArchive } from './archiveSurvey.js'
import type { AppCollectionSurvey } from './archiveSurvey.js'
import { walkCollection } from './collectionWalk.js'
import {
  descriptorFromCollectionLogFile,
  descriptorFromLogBody
} from './descriptorLog.js'
import {
  ciphersForCollection,
  indexSchemaFromCustom,
  recoverGenerations,
  zeroGenerations
} from './generations.js'
import type { UserKeyGeneration } from './generations.js'
import { CollectionTally, keyedRecord } from './report.js'
import type { MigrationCollectionReport, MigrationReport } from './report.js'
import { recipientFromSecret } from './secretToRecipient.js'
import type { MigrationSecret } from './secretToRecipient.js'
import { MIGRATION_WALK_ORDER, WALK_STOPPING_ERROR_NAME } from './sink.js'
import type {
  AppCollectionResource,
  MigrationSink,
  SinkOutcome
} from './sink.js'

/**
 * One collection the walk enters, and where its Resources go. `app` is present
 * for an app collection and carries its survey and the sink's
 * `ensureCollection`.
 */
type WalkStep = {
  collectionId: string
  importResource: (options: AppCollectionResource) => Promise<SinkOutcome>
  app?: AppCollectionSurvey & {
    ensureCollection: NonNullable<
      MigrationSink['appCollections']
    >['ensureCollection']
  }
}

/**
 * The walk's steps in order: the standard collections, with the app
 * collections, by id, just before activity, which stays last.
 *
 * @param options {object}
 * @param options.sink {MigrationSink}
 * @param options.appCollections {Map<string, AppCollectionSurvey>}   sorted
 *   by id
 * @returns {WalkStep[]}
 */
function walkSteps({
  sink,
  appCollections
}: {
  sink: MigrationSink
  appCollections: Map<string, AppCollectionSurvey>
}): WalkStep[] {
  const appSteps: WalkStep[] = []
  const appSink = sink.appCollections
  if (appSink !== undefined) {
    for (const [collectionId, app] of appCollections) {
      appSteps.push({
        collectionId,
        importResource: options => appSink.importResource(options),
        app: {
          ...app,
          ensureCollection: options => appSink.ensureCollection(options)
        }
      })
    }
  }
  const steps: WalkStep[] = []
  for (const { collectionId, method } of MIGRATION_WALK_ORDER) {
    if (collectionId === WALLET_ACTIVITY_COLLECTION) {
      steps.push(...appSteps)
    }
    steps.push({
      collectionId,
      // A standard collection is encrypted, so its Resources always arrive
      // parsed.
      importResource: ({ resourceId, ...body }) =>
        sink[method]({
          collectionId,
          resourceId,
          json: 'json' in body ? body.json : body.bytes
        })
    })
  }
  return steps
}

/**
 * Migrates a backup bundle's content into a host's stores.
 *
 * @param options {object}
 * @param options.bundle {ByteSource}   the outer bundle tar's bytes, or a
 *   stream of them
 * @param options.secret {MigrationSecret}   the old account's unlock
 *   passphrase, its recovery code, or the backup credential the bundle carries
 * @param options.sink {MigrationSink}   the host's import functions
 * @param [options.signal] {AbortSignal}   checked between Resources and before
 *   each collection is entered; the walk throws its `reason`
 * @param [options.onProgress] {function}   called once per Resource with
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
  const survey = await surveyArchive({
    archive,
    migrated,
    migratesAppCollections: sink.appCollections !== undefined
  })
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

    const steps = walkSteps({ sink, appCollections: survey.appCollections })
    for (const { collectionId, importResource, app } of steps) {
      // An abort between collections ends the walk here, before the next
      // collection is entered or made on the host.
      if (signal?.aborted) {
        throw signal.reason
      }
      if (app === undefined && !survey.present.has(collectionId)) {
        // A collection the archive does not carry was never entered, so it is
        // absent from the report rather than present with zeroes.
        continue
      }
      const tally = new CollectionTally()
      const logBytes = survey.collectionLogs.get(collectionId)
      // A standard collection is always encrypted. An app collection is unless
      // its metadata parsed with no `encryption` and it has no governing log.
      const encrypted = app?.encrypted ?? true
      let ciphers: EdvDocCipher[] | undefined
      try {
        if (logBytes !== undefined) {
          ciphers = await ciphersForCollection({
            generations,
            collectionId,
            encryption: descriptorFromCollectionLogFile({
              bytes: logBytes,
              collectionId
            })
          })
        } else if (encrypted) {
          throw new CollectionLogUnreadableError(
            `The archived collection "${collectionId}" carries no governing ` +
              'history log, so its encryption descriptor is unknown.'
          )
        }
        if (app !== undefined) {
          // An encrypted collection's blinded-index schema travels sealed in
          // its metadata `custom`; one that will not open is not handed on.
          const indexSchema =
            ciphers !== undefined && app.custom !== undefined
              ? await indexSchemaFromCustom({ ciphers, custom: app.custom })
              : undefined
          await app.ensureCollection({
            collectionId,
            encrypted,
            ...(app.isPublic && { isPublic: true }),
            ...(app.generator !== undefined && { generator: app.generator }),
            ...(indexSchema !== undefined && { indexSchema }),
            // A plaintext collection's `custom` is handed on as archived. An
            // encrypted one's is sealed to the old account's keys.
            ...(!encrypted &&
              app.custom !== undefined && { custom: app.custom })
          })
        }
      } catch (err) {
        // Resources have already reached the sink by now, so nothing here may
        // end the walk without a report. An unreadable log is the expected
        // cause; any other (a descriptor body no cipher can be built from, a
        // host that could not make the collection) is named as it came. No
        // Resource of this collection is handed over, so each is counted as
        // unopenable under the cause rather than dropped from the report.
        const cause = (err as Error).name
        tally.stoppedBy = cause
        const resources = survey.walkedResources.get(collectionId) ?? 0
        for (let index = 0; index < resources; index++) {
          tally.countUnopenable(cause)
        }
        collections.set(collectionId, tally.toReport())
        if (cause === WALK_STOPPING_ERROR_NAME) {
          stoppedAt = { collectionId, cause }
          break
        }
        continue
      }
      const { stopped } = await walkCollection({
        archive,
        collectionId,
        importResource,
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
