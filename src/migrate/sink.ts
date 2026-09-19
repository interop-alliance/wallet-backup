/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The sink port: the one wallet-specific seam of the migration walk. The walk
 * decrypts a row and hands it to the sink method of the collection it came
 * from; the sink writes it into the host's own stores and says what happened.
 * The package knows no wallet row types, so the plaintext row travels as
 * opaque JSON.
 *
 * The walk order and the collection-to-method mapping live here too, since
 * they are one decision: which collections migrate, in which order, through
 * which method. Every collection id is imported from the package that owns it
 * -- `@interop/wallet-core/space` for the wallet's own collections,
 * `@interop/social-core` for the contacts pair -- so a rename upstream reaches
 * the walk rather than drifting past a local copy.
 */
import {
  PRIVATE_CREDENTIALS_COLLECTION,
  WALLET_ACTIVITY_COLLECTION
} from '@interop/wallet-core/space/collections'
import {
  CONTACTS_COLLECTION,
  CONTACTS_HISTORY_COLLECTION
} from '@interop/social-core'

/**
 * What one sink call did with the row it was handed. `skipped` is the merge
 * rule's "the account already holds this row"; `conflicting` is "it holds that
 * identity under different content, and the archived row landed nowhere";
 * `failed` is a write that did not land and may be retried on a re-run.
 */
export type SinkOutcome = 'accepted' | 'skipped' | 'conflicting' | 'failed'

/**
 * One import function per migrated collection. Each takes one decrypted row
 * and reports its outcome. A method that throws is a `failed` row whose cause
 * name the report keeps -- except a throw named `QuotaExceededError`, which
 * stops the whole walk.
 */
export interface MigrationSink {
  importCredential(options: {
    collectionId: string
    resourceId: string
    row: unknown
  }): Promise<SinkOutcome>
  importContact(options: {
    collectionId: string
    resourceId: string
    row: unknown
  }): Promise<SinkOutcome>
  importContactRevision(options: {
    collectionId: string
    resourceId: string
    row: unknown
  }): Promise<SinkOutcome>
  importActivity(options: {
    collectionId: string
    resourceId: string
    row: unknown
  }): Promise<SinkOutcome>
}

/**
 * The name of the sink method each migrated collection's rows go to.
 */
export type MigrationSinkMethod = keyof MigrationSink

/**
 * The migrated collections in walk order: contacts before their history (so a
 * revision's head is already in place), then credentials, then activity last
 * -- the host writes its own import activity row after the walk, and running
 * activity last keeps the counts it carries final.
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
 * How many consecutive failures end a collection. A permanent per-row cause
 * must not wall off the rows behind it, so a failure never aborts a collection
 * on its own; a run of them is the outage case, and ten wasted writes is the
 * most an outage costs per collection. Not wire: a package constant a release
 * may change.
 */
export const MAX_CONSECUTIVE_FAILURES = 10

/**
 * The error name a sink throw must carry to stop the whole walk rather than
 * fail one row: was-client's 507, a wall that every later row would hit too.
 * Matched by name, never by `instanceof`, since the error is minted in another
 * package.
 */
export const WALK_STOPPING_ERROR_NAME = 'QuotaExceededError'
