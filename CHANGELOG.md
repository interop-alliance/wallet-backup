# @interop/wallet-backup Changelog

## 0.1.0 - TBD

### Added

- `pnpm run test:dist` builds the package and runs
  `test/probe/transportClosure.mjs`, which imports `dist/index.js` under a Node
  resolve hook and fails if any resolved module is a was-client transport
  module, was-client's `./edv` or root barrel, or wallet-core's `./space`
  barrel, `resourceLog/` or `clientAnnex/`.
- Listed as a party to the encrypted-collections contract, in that spec's
  AGENTS.md table and in ARCHITECTURE.md here.
- Initial commit.
- Renamed from `@interop/isomorphic-lib-template` to `@interop/wallet-backup`.
- Per-Space archive codec (`src/archive/`): `packSpaceArchive` and its entry
  tree, the `manifest.yml` builder, the on-disk file-name dialect, and the six
  manifest URL constants, moved over from the WAS reference server. The writer
  is isomorphic (`Uint8Array` bytes, no `node:stream`) and returns the
  tar-stream pack.
- Space archive reader: `readSpaceArchive` walks a tar lazily, with
  `parseArchivePath` and `classifyCollectionFile` reading entry paths and file
  names back through the writer's own codec.
- Outer bundle codec (`src/bundle/`): `writeBundle` / `readBundle` over the
  FEP-6fcd manifest, the `BUNDLE_ROLE` role anchors, and `accountSpaceArchive`.
  An opened bundle carries `close()`, which releases the source for a caller
  that stops before walking `spaces` to its end.
- Packed recovery code: `packRecoveryCode` / `unpackRecoveryCode`, plain or
  sealed to an export passphrase under the keyring Argon2id parameters with a
  fresh per-bundle random salt.
- Content-migration walk (`src/migrate/`):
  `migrateBundle({ bundle, secret, sink, signal, onProgress })` recovers the old
  user key generations from the archived roster, decrypts each standard
  collection's rows, pushes them one at a time at the host's `MigrationSink`,
  and returns a `MigrationReport`. It issues no HTTP request, holds one row at a
  time, and zeroes every recovered generation secret and the derived seed when
  it ends.
- Migration secrets: an unlock passphrase, a recovery code, or the bundle's own
  packed code (plain, or unsealed with the export passphrase).
- Sink port: one import function per migrated collection (`contacts`,
  `contacts-history`, `private-credentials`, `wallet-activity`, in that walk
  order), each answering `accepted` / `skipped` / `conflicting` / `failed`. Ten
  consecutive failures end a collection; a `QuotaExceededError`-named throw ends
  the walk. `app-connections` and every other collection are counted under the
  report's `notMigrated` and reach no import function.
- An archived Collection's governing history log is read as the server's stored
  record (`{ body, generation, version }`), the form both server backends
  export; the checked-in Space archive fixture carries that form.
- Error classes told apart by `name`: `BundleInvalidError`,
  `AccountSpaceArchiveMissingError`, `BundleRecipientMissingError`,
  `CollectionLogUnreadableError`, `ChunkedResourceUnsupportedError`.
- Checked-in Space archive fixture and its generator script, so the reference
  server's counterpart test can assert its export of the same tree is
  byte-identical.
- Decision-record convention: `decisions/` directory (README + TEMPLATE) for
  cross-repo decisions, plus the "Decision Records" section in AGENTS.md.
- Decision-record scope widened: a pre-implementation design review may also
  mint a record for a repo-internal do-not-reopen decision.
- Design-gate convention: `designs/` directory (README + TEMPLATE) for
  pre-implementation design docs on cross-cutting items, plus the `design:` /
  `design-approved:` item fields and gate rule in AGENTS.md.
- ARCHITECTURE.md skeleton (layer map, numbered invariants, ownership
  heuristics, current state labels), plus the "Architecture" section in
  AGENTS.md; the design gate, `touches:`, and the breaking-release audit all key
  on this file.

### Changed

- The per-Space archive codec moved to `@interop/space-archive`. Archive exports
  (`packSpaceArchive`, `readSpaceArchive`, the manifest URL constants, the
  file-name dialect) and the byte-source and tar-walk helpers (`byteChunks`,
  `collectBytes`, `ByteSource`, `tarEntries`, `TarEntry`) are no longer exported
  from this package. This is a breaking change: import them from
  `@interop/space-archive` instead. `ByteSource` stays re-exported here as a
  type only, since `readBundle` and `migrateBundle` take one as a parameter.
- `@interop/wallet-core` (`>=0.79.1 <1.0.0`) and `@interop/was-client`
  (`>=0.70.0 <1.0.0`) are peer dependencies. The host wallet supplies both.
- Every wallet-core import is a leaf entry (`keyring/kdf`,
  `keyring/recordEnvelope`, `keys/userKey`, `keys/userKeyGenerations`,
  `unlock/standingClient`, `recovery/recoveryCode`, `space/collections`) rather
  than a module barrel, so importing this package evaluates no did:webvh, zcap
  or WAS transport module.
- `BundleInvalidError` is now re-exported from `@interop/space-archive`, which
  defines it. Every throw site in this package still raises the same class.
