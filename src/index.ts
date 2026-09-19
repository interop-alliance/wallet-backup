/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `@interop/wallet-backup`: the backup bundle codec and content-migration walk
 * for portable wallets. One door onto two parts -- the outer bundle
 * (`./bundle`) and the walk that reads content back out of one (`./migrate`).
 * The per-Space export archive a bundle carries is `@interop/space-archive`'s;
 * consumers that need its codec import that package directly rather than
 * through here.
 *
 * `ByteSource` is re-exported as a type only, because `readBundle` and
 * `migrateBundle` take one as a parameter: a caller can name the parameter
 * type without a separate dependency on `@interop/space-archive`.
 */
export * from './bundle/index.js'
export * from './migrate/index.js'

export type { ByteSource } from '@interop/space-archive'

export {
  AccountSpaceArchiveMissingError,
  BundleInvalidError,
  BundleRecipientMissingError,
  ChunkedResourceUnsupportedError,
  CollectionLogUnreadableError
} from './errors.js'
