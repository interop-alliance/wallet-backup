/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The content-migration walk: `migrateBundle` drives it, the host supplies a
 * `MigrationSink`, and the walk hands back a `MigrationReport`. Nothing here
 * issues a request, and no key material outlives the call.
 */
export { migrateBundle } from './migrateBundle.js'

export { recipientFromSecret } from './secretToRecipient.js'
export type {
  MigrationRecipient,
  MigrationSecret,
  RecipientKeyAgreementKey
} from './secretToRecipient.js'

export {
  MAX_CONSECUTIVE_FAILURES,
  MIGRATION_WALK_ORDER,
  WALK_STOPPING_ERROR_NAME
} from './sink.js'
export type { MigrationSink, MigrationSinkMethod, SinkOutcome } from './sink.js'

export type { MigrationCollectionReport, MigrationReport } from './report.js'

export {
  descriptorFromCollectionLogFile,
  descriptorFromLogBody
} from './descriptorLog.js'
