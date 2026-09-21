/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The outer bundle codec: the tar-in-tar a wallet exports (a manifest, an
 * optional packed recovery code, and one per-Space archive per Space) and the
 * reader that opens it.
 */
export {
  bundleManifestSummary,
  buildBundleManifest,
  spaceArchivePath,
  spaceArchiveRoles,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_ROLE,
  BUNDLE_SPEC,
  PROFILE_SPEC_URL,
  RECOVERY_CODE_FILE,
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

export { packRecoveryCode, unpackRecoveryCode } from './recoveryCode.js'
export type { PackedRecoveryCode } from './recoveryCode.js'
