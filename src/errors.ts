/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The package's error classes. Each sets its own `name`, and that name is the
 * contract: a consumer in another package tells these apart by `err.name`,
 * never by `instanceof`, since two copies of this package in one dependency
 * tree carry two distinct classes for the same failure.
 *
 * `BundleInvalidError` is defined in `@interop/space-archive` and re-exported
 * here, since that package's per-Space archive reader raises the same class
 * for the same reason: bytes that will not read back as a tar of the expected
 * shape. Along with the next two below, it is raised before any content is
 * handed to a sink -- a bundle that cannot be opened at all. The last two are
 * reported per row or per collection by the migration walk, which carries on
 * with the rest.
 */
export { BundleInvalidError } from '@interop/space-archive'

/**
 * The bundle names no account Space archive -- no `contents` entry carries the
 * `#account-space-archive` role, or the entry names a file the archive does
 * not hold. Nothing else in the bundle can be read without it: the account
 * Space is where the user key roster lives.
 */
export class AccountSpaceArchiveMissingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AccountSpaceArchiveMissingError'
  }
}

/**
 * The secret in hand is not a recipient of the bundle's user key: unwrapping
 * the roster's generations for it yielded none. Raised before any row is
 * decrypted, so a wrong passphrase or recovery code fails the whole walk
 * rather than emptying it row by row.
 */
export class BundleRecipientMissingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BundleRecipientMissingError'
  }
}

/**
 * A Collection's governing history log could not be read, so its encryption
 * descriptor is unknown and its rows cannot be opened. Reported against that
 * collection and the collection is skipped; the walk continues.
 */
export class CollectionLogUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CollectionLogUnreadableError'
  }
}

/**
 * A Resource is stored in chunks, which the migration walk does not open.
 * Reported as that one row's cause; the rest of the collection is migrated.
 */
export class ChunkedResourceUnsupportedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChunkedResourceUnsupportedError'
  }
}
