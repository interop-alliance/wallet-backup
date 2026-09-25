/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The outer bundle codec: the tar-in-tar a wallet exports (a manifest, an
 * optional packed backup credential, and one per-Space archive per Space) and
 * the reader that opens it.
 */
export {
  bundleManifestSummary,
  buildBundleManifest,
  spaceArchivePath,
  spaceArchiveRoles,
  BACKUP_CREDENTIAL_FILE,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_ROLE,
  BUNDLE_SPEC,
  PROFILE_SPEC_URL,
  SPACES_DIRECTORY
} from './manifest.js'
export type {
  BundleManifest,
  BundleManifestSummary,
  BundleMeta,
  BundleSpaceRole
} from './manifest.js'

export { exportBundle } from './exportBundle.js'
export type { ExportStage } from './exportBundle.js'

export { writeBundle } from './writeBundle.js'
export type { BundleSpaceInput } from './writeBundle.js'

export { accountSpaceArchive, readBundle } from './readBundle.js'
export type { Bundle, BundleSpaceEntry } from './readBundle.js'

export {
  packBackupCredential,
  unpackBackupCredential
} from './backupCredential.js'
export type { PackedBackupCredential } from './backupCredential.js'
