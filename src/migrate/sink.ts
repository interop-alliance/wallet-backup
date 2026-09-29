/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The sink port: the one wallet-specific seam of the migration walk. The walk
 * decrypts a Resource and hands it to the sink method of the collection it came
 * from; the sink writes it into the host's own stores and says what happened.
 * The package knows no wallet data types, so the plaintext Resource travels as
 * opaque JSON.
 *
 * The walk order and the collection-to-method mapping live here too, since
 * they are one decision: which collections migrate, in which order, through
 * which method. Every collection id is imported from the package that owns it
 * -- `@interop/wallet-core/space` for the wallet's own collections,
 * `@interop/social-core` for the contacts pair -- so a rename upstream reaches
 * the walk rather than drifting past a local copy.
 *
 * Beside the four standard collections, the walk carries app collections: the
 * collections outside the wallet Space's own layout, which a connected app had
 * the wallet provision. The sink opts into them through its optional
 * `appCollections` member.
 */
import {
  PRIVATE_CREDENTIALS_COLLECTION,
  WALLET_ACTIVITY_COLLECTION
} from '@interop/wallet-core/space/collections'
import {
  CONTACTS_COLLECTION,
  CONTACTS_HISTORY_COLLECTION
} from '@interop/social-core'
import type { CollectionGenerator, IndexSchema } from '@interop/was-client'

/**
 * What one sink call did with the Resource it was handed. `skipped` is the
 * merge rule's "the account already holds this Resource"; `conflicting` is "it
 * holds that identity under different content, and the archived Resource landed
 * nowhere"; `failed` is a write that did not land and may be retried on a
 * re-run.
 */
export type SinkOutcome = 'accepted' | 'skipped' | 'conflicting' | 'failed'

/**
 * One app collection Resource as `importResource` receives it. `contentType` is
 * the archived representation's content type, and an encrypted collection's
 * decrypted Resource is always `application/json`. A JSON type, by
 * storage-core's `isJsonContentType` (`application/json` or an
 * `application/...+json` type), arrives parsed as `json`; any other arrives as
 * the archived `bytes`, unparsed.
 */
export type AppCollectionResource = {
  collectionId: string
  resourceId: string
  contentType: string
} & ({ json: unknown } | { bytes: Uint8Array })

/**
 * One import function per migrated standard collection. Each takes one
 * decrypted Resource, parsed as `json`, and reports its outcome. A method that
 * throws is a `failed` Resource whose cause name the report keeps -- except a
 * throw named `QuotaExceededError`, which stops the whole walk.
 *
 * `appCollections` is optional. A sink that carries it migrates app collections
 * too. `ensureCollection` is called once per app collection, before its first
 * Resource is opened. `encrypted` says whether the collection is client-side
 * encrypted, so the host creates the same kind: its archived Collection
 * Metadata declares `encryption`, or it carries a governing collection log. An
 * encrypted collection with no log is stopped before `ensureCollection` under
 * `CollectionLogUnreadableError`. `isPublic` is `true` when the archived
 * collection policy is `PublicCanRead`, and absent otherwise. `generator` is
 * the one its archived Collection Metadata object names, absent when that file
 * names none or does not parse. `indexSchema` is the blinded-index schema
 * sealed in an encrypted collection's archived metadata `custom`, absent when
 * there is none, it declares no index, or no held generation opens it. `custom`
 * is a plaintext collection's archived metadata `custom` value, handed on as
 * archived. It is absent for an encrypted collection, whose `custom` is sealed
 * to the old account's keys, and when the metadata carries none. A throw from
 * it stops that collection, and a throw named `QuotaExceededError` stops the
 * whole walk. `importResource` follows the same outcome and throw rules as the
 * four standard methods. An encrypted collection's Resource arrives decrypted;
 * a plaintext one's arrives parsed as JSON or as raw bytes, by its content type
 * (see `AppCollectionResource`). Either way it keeps its archived `resourceId`.
 * A sink without the member leaves every app collection's Resources counted in
 * `notMigrated`.
 */
export interface MigrationSink {
  importCredential(options: {
    collectionId: string
    resourceId: string
    json: unknown
  }): Promise<SinkOutcome>
  importContact(options: {
    collectionId: string
    resourceId: string
    json: unknown
  }): Promise<SinkOutcome>
  importContactRevision(options: {
    collectionId: string
    resourceId: string
    json: unknown
  }): Promise<SinkOutcome>
  importActivity(options: {
    collectionId: string
    resourceId: string
    json: unknown
  }): Promise<SinkOutcome>
  appCollections?: {
    ensureCollection(options: {
      collectionId: string
      encrypted: boolean
      isPublic?: boolean
      generator?: CollectionGenerator
      indexSchema?: IndexSchema
      custom?: unknown
    }): Promise<void>
    importResource(options: AppCollectionResource): Promise<SinkOutcome>
  }
}

/**
 * The name of the sink method each migrated standard collection's Resources go
 * to.
 */
export type MigrationSinkMethod = Exclude<keyof MigrationSink, 'appCollections'>

/**
 * The migrated standard collections in walk order: contacts before their
 * history (so a revision's head is already in place), then credentials, then
 * activity last -- the host writes its own import activity row after the walk,
 * and running activity last keeps the counts it carries final. The app
 * collections walk between credentials and activity, by id.
 */
export const MIGRATION_WALK_ORDER: ReadonlyArray<{
  collectionId: string
  method: MigrationSinkMethod
}> = [
  { collectionId: CONTACTS_COLLECTION, method: 'importContact' },
  {
    collectionId: CONTACTS_HISTORY_COLLECTION,
    method: 'importContactRevision'
  },
  {
    collectionId: PRIVATE_CREDENTIALS_COLLECTION,
    method: 'importCredential'
  },
  { collectionId: WALLET_ACTIVITY_COLLECTION, method: 'importActivity' }
]

/**
 * How many consecutive failures end a collection. A permanent per-Resource
 * cause must not wall off the Resources behind it, so a failure never aborts a
 * collection on its own; a run of them is the outage case, and ten wasted
 * writes is the most an outage costs per collection. Not wire: a package
 * constant a release may change.
 */
export const MAX_CONSECUTIVE_FAILURES = 10

/**
 * The error name a sink throw must carry to stop the whole walk rather than
 * fail one Resource: was-client's 507, a wall that every later Resource would
 * hit too. Matched by name, never by `instanceof`, since the error is minted in
 * another package.
 */
export const WALK_STOPPING_ERROR_NAME = 'QuotaExceededError'
