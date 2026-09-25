# Architecture

The current shape of this library, with the rationale inline: why each part is
shaped the way it is, stated where the shape is described. This file is kept
current in the same change set that alters the shape; it overwrites in place and
records no history. History lives elsewhere: CHANGELOG.md for what landed,
`decisions/` for durable decisions with their rejected alternatives and revisit
criteria, and the archived roadmap for the work items. Reference decision
records from here where the resulting shape is described, instead of re-arguing
them.

Several conventions lean on this file, so keep it accurate and current: the
design gate defines a cross-cutting item as one touching an invariant documented
here, a `touches:` entry names this file as a deliverable in its own right, and
the breaking-release audit checks its statements against the code.

## Layer map

```
src/index.ts              Public entry point (the export map's only door)
src/errors.ts             The package's error classes, told apart by `name`
src/standingAgents.ts     One unlock secret to its standing client agents, byproducts wiped

src/bundle/index.ts       The outer bundle codec's door
src/bundle/manifest.ts    The bundle manifest, its `spec`, and the role anchors
src/bundle/exportBundle.ts The export ceremony: credential, Space list, archives, pack
src/bundle/writeBundle.ts Packs manifest + packed credential + one archive per Space
src/bundle/readBundle.ts  Opens a bundle; `accountSpaceArchive` finds the account tar
src/bundle/backupCredential.ts The packed backup credential, plain or sealed

src/migrate/index.ts              The migration walk's door
src/migrate/migrateBundle.ts      `migrateBundle`: bundle + secret + sink to a report
src/migrate/secretToRecipient.ts  One old secret to the roster recipient it stands for
src/migrate/descriptorLog.ts      An archived governing log to its encryption descriptor
src/migrate/generations.ts        The user key generations, and a cipher per generation
src/migrate/archiveSurvey.ts      One pass gathering the logs, chunk dirs, and row counts
src/migrate/collectionWalk.ts     One collection's rows, one at a time, to the sink
src/migrate/report.ts             The report shape and the per-collection tally
src/migrate/sink.ts               The sink port, the walk order, and the walk's two limits
```

The per-Space archive codec -- the file-name dialect, the manifest, the packer
and the reader, and the byte-source and tar-walk helpers they share -- lives in
`@interop/space-archive`, not under `src/`. `bundle/` and `migrate/` both read
it: `bundle/` for the shared manifest parse, the epoch `mtime`, and the URL
constants, and `migrate/` for the reader and its path and file-name classifiers.
The dependency direction inside this package is one way: `migrate/` reads
`bundle/`, and neither reads the other's internals.

## Invariants

1. **An archive is byte-reproducible.** Every tar header carries the epoch
   `mtime` (`EXPORT_ENTRY_MTIME`), so two packs of an unchanged entry tree are
   byte-identical. Upheld by `@interop/space-archive`'s writer and this
   package's `writeBundle.ts`, and pinned by the checked-in fixture in that
   package, which a counterpart test in the WAS reference server compares its
   own export against.
2. **A Space archive's bytes pass through a bundle untouched.** The bundle is a
   container, not a re-encoding: `writeBundle` copies each archive verbatim and
   `readBundle` hands the same bytes back.
3. **Nothing large is held whole.** Both readers parse their manifest from the
   first tar entry and then walk lazily, so at most one Space archive is in
   memory at a time. The walks are one-shot: a caller iterates them once and
   reads an entry's bytes before advancing. The migration walk holds one row on
   top of that: it awaits each sink call before it reads the next entry, and it
   buffers nothing per collection but the small documents `archiveSurvey.ts`
   gathers (each governing log and the chunk-directory names).
4. **The codecs are isomorphic.** No module under `src/` imports `node:*`, and
   no public type names `Buffer`; bytes are `Uint8Array` and streams arrive as a
   `ByteSource` (`@interop/space-archive`'s type, re-exported here since
   `readBundle` and `migrateBundle` take one as a parameter). A Playwright spec
   packs and reads both the bundle and the per-Space archive in Chromium to keep
   this honest. The `events` dependency exists for the browser. Nothing in
   `src/` imports it, but `writeBundle.ts` imports `tar-stream`, whose streams
   (`streamx`, through `events-universal`) call `require('events')` without
   declaring a package that provides it outside Node. A bundler resolves that
   call to the `events` package declared here. Without it the browser spec fails
   inside `tar-stream`.
5. **A sealed backup credential introduces no cipher context of its own.** It
   seals through wallet-core's record construction under the keyring cipher
   context, with the keyring Argon2id parameters and a fresh per-bundle random
   salt. So no packed credential shares a derived key with another bundle or
   with the wallet's own account derivation. The credential's own derivation,
   from its 32 secret bytes to its standing identity, is wallet-core's
   `BACKUP_CREDENTIAL_KDF`, which this package imports and does not restate. A
   reader holds a sealed document's KDF descriptor to that parameter set before
   deriving anything: only the salt may differ, and a descriptor naming another
   algorithm or cost is refused with `BundleInvalidError`, so a tampered bundle
   cannot choose the Argon2id work the reader pays.
6. **Role anchors and manifest URLs are permanent wire text.** They are exported
   constants (`BUNDLE_ROLE`, the six archive manifest URLs) and are copied,
   never rewritten -- a reader finds the account Space archive by matching an
   anchor, and nothing else marks which tar is which.
7. **The migration walk issues no request, and the package evaluates no
   transport module.** The walk builds its ciphers without a `spaceId`, so
   was-client constructs no transport, and it reads every descriptor out of the
   archive. A bundle migrates with the old account gone and the old server
   unreachable. The node suites install a `fetch` that throws, so a walk that
   reached the network would fail rather than pass. The import graph keeps the
   same promise: the ciphers and epoch primitives come from
   `@interop/was-client/edv/core`, and every wallet-core derivation and
   collection name comes from a leaf entry (`keyring/kdf`,
   `keyring/recordEnvelope`, `keys/userKey`, `keys/userKeyGenerations`,
   `unlock/standingClient`, `recovery/recoveryCode`, `space/collections`) rather
   than a module barrel. `test/probe/transportClosure.mjs` imports the built
   package under a Node resolve hook and fails if any resolved module is a
   was-client module that talks to a server, was-client's `./edv` or root
   barrel, or wallet-core's `./space` barrel, `resourceLog/` or `clientAnnex/`.
   It runs as `pnpm run test:dist`. One reach is allowed by design: the client
   derivations load `@interop/was-client/identity`, which brings the zcap and
   HTTP signing packages, wallet-core's own recorded allowance for its leaves.
8. **Key material does not outlive the walk, as far as it can be scrubbed.**
   `migrateBundle` zeroes every recovered generation's raw `secret` and every
   derived unlock seed in a `finally`, so an abort and a refusal drop them as an
   ordinary end does, and nothing key-shaped is in the report. The packed backup
   credential's export-passphrase derivation does the same, at both the sealing
   and the opening call. The unpacked secret bytes and the unlock seed derived
   from them are zeroed as soon as the recipient key is derived, and so are the
   client seed and binding MAC key every standing client derivation hands back
   beside its agents. The bound is what can be overwritten in place: the key
   objects built from that material -- the `X25519KeyAgreementKey2020` instances
   `userKeyVaultKeys` and the client derivations return -- carry their private
   half as an immutable `privateKeyMultibase` string, which no code can scrub.
   Those are dropped when the walk ends and reclaimed by garbage collection, on
   the collector's schedule rather than the walk's.
9. **An export establishes the backup credential before it reads the Space
   list.** `exportBundle` runs the ceremony in one order: establish the
   credential through the host's own establishment port, then list the Spaces,
   then export each in the order listed, then pack. The establishment writes the
   credential's own unlock Space, so reading the list second is what makes the
   bundle self-sufficient. The credential a reader unpacks opens a Space that
   bundle carries. A list naming no account Space refuses before any export
   runs, and a Space export that fails fails the whole ceremony, since a bundle
   silently missing one sibling reads as complete and is not. The secret bytes
   are held for the one `packBackupCredential` call, zeroed in place as soon as
   it returns, and never returned; the host hands over a copy if it needs them.
10. **The walk refuses early or counts.** `BundleInvalidError`,
    `AccountSpaceArchiveMissingError` and `BundleRecipientMissingError` are
    raised before any row reaches a sink. Past that point every failure is a
    number in the report -- an unreadable collection log, a row no generation
    opens, a write that did not land -- except a sink throw named
    `QuotaExceededError`, which ends the walk and is named in `stoppedAt`.

## Ownership heuristics

- The archive dialect (file names, manifest shape, pack order) belongs to
  `@interop/space-archive`, shared with the WAS reference server, which builds
  the entry trees out of its own storage backends. A change to it is a change to
  both, and to this package as a consumer of the reader and writer. See that
  package's AGENTS.md for its own parties table.
- Key derivation, record sealing, roster and epoch handling belong to
  `@interop/wallet-core` and `@interop/was-client`. This package calls them; it
  does not re-derive a KDF, a cipher, or an envelope shape. Both are peer
  dependencies, so the host wallet's one copy serves this package too. A second
  copy could carry different collection names or KDF parameters than the wallet
  it migrates into, and nothing would fail.
- The encrypted-collections profile (the `CollectionEncryption` descriptor, the
  epoch roster, the envelope) belongs to the encrypted-collections spec and its
  reference implementation in `@interop/was-client`. This package is a listed
  party to that contract, as a consumer: `migrate/descriptorLog.ts` reads a
  descriptor out of an archived resource log, `migrate/generations.ts` unwraps
  its epoch secrets and opens rows through `createEdvDocCipher`, and
  `bundle/backupCredential.ts` seals the packed credential under a one-epoch
  descriptor of the same construction. A normative change there is a walk of
  that spec's parties table and reaches this repo through it.
- Encoding primitives (base64url and friends) come from `@scure/base`.
- HTTP belongs to the host. Nothing here fetches: a bundle is bytes in, bytes
  out.

## Glossary

- **Bundle** -- the backup file a wallet exports: one tar holding a manifest, an
  optional packed backup credential, and one per-Space archive per Space. Lives
  in `src/bundle/`. Avoid: backup file, export file, archive (which means the
  inner per-Space tar here).
- **Per-Space archive** -- the UBC v0.1 export tarball of a single Space, the
  dialect the WAS reference server writes. Carried verbatim inside a bundle as
  `spaces/<spaceId>.tar`. Reader and writer live in `@interop/space-archive`;
  this package consumes them for the bundle codec and the migration walk. Avoid:
  space export, space dump, inner tar.
- **Archive role** -- what one Space archive is to the account: the account
  Space, the client annex Space, or the unlock Space. Carried as the `url`
  anchor of the archive's manifest `contents` entry, named by `BUNDLE_ROLE`.
  Avoid: space type, kind, category.
- **Export ceremony** -- one run of `exportBundle`: a backup credential
  established, the account's Spaces listed and exported one at a time, and a
  bundle packed. The package owns the order; the host owns the effects, handed
  in as ports. Lives in `src/bundle/exportBundle.ts`. Avoid: backup run, export
  flow, dump.
- **Packed backup credential** -- the bundle's `backup-credential.json`: the 32
  secret bytes of the backup credential (a standing unlock credential the wallet
  establishes for the export), base64url without padding, either in the clear
  (`form: 'plain'`) or sealed to an export passphrase (`form: 'sealed'`). Lives
  in `src/bundle/backupCredential.ts`. Avoid: packed code, backup code, sealed
  seed.
- **Export passphrase** -- the passphrase a user types at export time to seal
  the packed backup credential, and again at import time to open it. Distinct
  from the wallet's own unlock passphrase, and derived under a fresh per-bundle
  salt so the two never produce the same key. Avoid: backup password, export
  password.
- **Byte source** -- anything the readers accept as input bytes: a `Uint8Array`,
  a web `ReadableStream`, or an async iterable of chunks. Defined in
  `@interop/space-archive`, re-exported here as a type since `readBundle` and
  `migrateBundle` take one as a parameter. Avoid: input stream, reader, source
  stream.
- **Migration** -- one run of `migrateBundle`: a bundle and one old secret in,
  decrypted rows pushed at a sink, a report out. Lives in `src/migrate/`. Avoid:
  import, restore, recovery (which is the recovery code's word here).
- **Sink** -- the host's side of the migration: one import function per migrated
  collection, each taking one decrypted row and answering `accepted`, `skipped`,
  `conflicting` or `failed`. The only wallet-specific code the walk touches, and
  the reason this package knows no wallet row types. See
  `decisions/0001-the-walk-lives-here-behind-a-push-sink.md`. Avoid: writer,
  handler, callback, consumer.
- **Generation** -- one epoch of the account's user key, recovered from the
  archived roster. Every generation is wrapped to every enrolled secret, so one
  old secret recovers the whole history; a row is opened by whichever generation
  holds its collection's epoch. Avoid: user key version, key epoch (which is the
  collection-side term), rotation.
- **Report** -- what a finished walk hands back: the bundle manifest minus its
  `contents`, the per-collection counts, the rows the walk did not migrate, and
  a `stoppedAt` where a quota refusal ended it. The host builds its own activity
  row from it; the walk writes none. Avoid: summary, result, stats.

## Current State labels

None. Every `@interop/*` dependency is consumed from the npm registry.
