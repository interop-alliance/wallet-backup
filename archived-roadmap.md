# Isomorphic Lib Template Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](ROADMAP.md), moved here verbatim when they
ship so that item-number references (WBU-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

---

### WBU-1: Move the per-Space archive codec into `@interop/space-archive`

- status: done (2026-09-18)
- priority: high
- labels: archive, packaging, cross-repo
- touches:
  - space-archive -- shipped 2026-09-18: package filled in from the
    isomorphic-lib-template; `src/archive/`, `src/stream.ts` and
    `src/tarEntries.ts` moved in verbatim, along with `BundleInvalidError` and
    `test/fixtures/space-archive/` with its generator; 12 vitest and 1
    Playwright test pass; its AGENTS.md carries the "Parties to this contract"
    table for the layout (PWP-4)
  - wallet-backup -- shipped 2026-09-18: `src/archive/`, `src/stream.ts` and
    `src/tarEntries.ts` removed; the bundle codec and the walk import the codec
    from `@interop/space-archive`; `BundleInvalidError` re-exported from there;
    decision 0001 amended in place (the layout's one implementation lives in
    space-archive, this package stays the walk's home); the parties table here
    shrinks to the bundle and the walk; `package.json` drops `mime-types` and
    `@types/mime-types` and adds
    `@interop/space-archive: link:../space-archive`; ARCHITECTURE.md and
    README.md updated; 47 vitest and 1 Playwright test pass
  - was-teaching-server -- shipped 2026-09-18: depends on
    `@interop/space-archive` (`link:../space-archive`) instead of
    `@interop/wallet-backup`; seven import sites repointed;
    `test/space-archive-fixture.test.ts` resolves the fixture through the new
    package; ARCHITECTURE.md and CHANGELOG.md updated; 1414 vitest tests pass
  - portable-wallet-profile-spec -- shipped: PWP-4's `touches:` names
    space-archive as the codec's home in place of wallet-backup, and its
    AGENTS.md parties table gained a space-archive row
- acceptance:
  - [x] The server's dependency tree carries no `@interop/wallet-core`
        (`pnpm why @interop/wallet-core` in the server is empty)
  - [x] `@interop/space-archive` depends on nothing under `@interop/*`
  - [x] Both suites (space-archive, wallet-backup) and the server's counterpart
        test pass with the fixture read from space-archive
  - [x] `touches:` entries resolved

Context: the read side landed 2026-09-18 with the per-Space archive codec inside
this package, so the server, which needs only the codec, installed wallet-core,
was-client, social-core, vh-resource-log, and Argon2 through it. The codec and
the walk have different consumers and different dependency sets; one
implementation of the layout is kept, one package lower. Putting the codec in
was-client or storage-core was weighed and not taken: the first moves a
server-side concern into a client library, the second adds tar and YAML to a
types package.

discovered-from: freewallet FW-549 (the 2026-09-18 landing review).

Build notes (captured 2026-09-18 for the session that runs the move):

- What moves, verbatim:
  `src/archive/{index,manifestUrls,resourceFileName, exportManifest,exportTar,readSpaceArchive}.ts`,
  `src/stream.ts` and `src/tarEntries.ts` (the byte-source and tar-walk helpers
  the reader and the bundle codec share; the bundle codec then imports them from
  space-archive), `test/node/archive.test.ts`, `test/browser/archive.spec.ts`,
  `test/fixtures/space-archive/` (the generator and `space-archive.tar`). Keep
  every comment and the exact bytes the packer and the fixture produce; the
  server's counterpart test asserts byte-identity.
- Import sites in this package to repoint at `@interop/space-archive`:
  `src/bundle/manifest.ts` (`UBC_MANIFEST_URL`), `src/bundle/writeBundle.ts`
  (`EXPORT_ENTRY_MTIME`), `src/bundle/readBundle.ts` (`parseArchiveManifest`),
  `src/migrate/archiveSurvey.ts` and `src/migrate/collectionWalk.ts`
  (`readSpaceArchive` and the classifier helpers), and `src/index.ts` (drop
  `export * from './archive/index.js'`; decide whether to re-export the codec or
  let consumers import space-archive directly -- the server should import
  space-archive directly either way).
- Server import sites: `src/backends/filesystem.ts` (lines ~59-60),
  `src/backends/postgres.ts` (~64-65, ~3822), `src/lib/importTar.ts` (17),
  `src/requests/ChunkRequest.ts` (22), `test/storage.test.ts` (13),
  `test/space-archive-fixture.test.ts` (35; and its fixture path resolves
  through `import.meta.resolve('@interop/wallet-backup')` at ~51, which becomes
  `'@interop/space-archive'`). The server then drops `@interop/wallet-backup`
  from package.json entirely.
- `vite.config.ts`'s `optimizeDeps.entries: ['src/index.ts']` was added here for
  the Playwright spec under the linked wallet-core graph; the new package's spec
  imports only the codec, so it may not need it.
- The `events` devDependency here exists because tar-stream -> streamx ->
  events-universal needs bare `events` in a browser bundle; it moves to
  space-archive (and stays here only if the bundle codec still bundles
  tar-stream directly, which it does).
- Dependency links at the time of filing: this package holds
  `link:../wallet-core` (unpublished `recordEnvelopeId`); the server holds
  `link:../wallet-backup`. The move replaces the server's link with
  `link:../space-archive` until space-archive publishes.
- Decision 0001 amendment text: the "one implementation" of the layout is
  `@interop/space-archive`'s reader and writer; this package consumes it for the
  bundle codec and the walk; the server consumes it for export. Amend in place
  with a dated note; do not supersede.
- Parties table split: space-archive's AGENTS.md carries the PWP-4 layout rows
  (profile spec, space-archive, was-teaching-server writer + counterpart test,
  wallet-backup reader); this package's table keeps the bundle and walk rows
  (profile spec PWP-2, this package, freewallet sink, dcw sink).

### WBU-2: Register wallet-backup as a party to the encrypted-collections contract

- status: done (2026-09-19)
- priority: medium
- labels: docs, cross-repo
- touches:
  - encrypted-collections-spec -- shipped 2026-09-19: AGENTS.md "Parties to this
    contract" table gained the wallet-backup row (`src/migrate/` and
    `src/bundle/recoveryCode.ts`, a consumer that re-derives nothing)
  - wallet-backup -- shipped 2026-09-19: ARCHITECTURE.md "Ownership heuristics"
    names the encrypted-collections contract, the three modules here that read
    it, and that a normative change reaches this repo through the spec's table
- acceptance:
  - [x] The spec's parties table lists wallet-backup with `src/migrate/` (the
        descriptor read in `descriptorLog.ts`, the row open in `generations.ts`)
        and `src/bundle/recoveryCode.ts` (the one-epoch record descriptor)
  - [x] ARCHITECTURE.md here states the same relationship

Context: The walk opens encrypted rows offline. It reads a collection's
encryption descriptor from the archived resource log, unwraps epoch secrets, and
decrypts documents through `createEdvDocCipher`. The packed recovery code is
sealed under a one-epoch descriptor of the same construction. That makes this
package a consumer of the encrypted-collections profile, but the spec's parties
table does not list it. A normative change there is a walk of that table, so a
missing row means a breaking change to the descriptor or the envelope would not
reach this repo's checklist.

Found while scoping whether the keyring and cipher imports belong in a
standalone library (2026-09-18).

### WBU-3: Import the derivations and ciphers without the transport graph

- status: done (2026-09-19)
- priority: low
- labels: packaging, cross-repo
- acceptance:
  - [x] `src/` imports every wallet-core derivation and collection name from a
        leaf entry, and the ciphers from `@interop/was-client/edv/core`
  - [x] `test/probe/transportClosure.mjs` (run by `pnpm run test:dist`) imports
        `dist/index.js` under a Node resolve hook and fails on any was-client
        transport module, was-client's `./edv` or root barrel, or wallet-core's
        `./space` barrel, `resourceLog/` or `clientAnnex/`
  - [x] ARCHITECTURE.md invariant 7 states the leaf-entry rule and the probe

Context: Everything this package takes from `@interop/wallet-core` and
`@interop/was-client/edv` is offline work: a KDF, a record cipher, a client
derivation, a user key unwrap, a doc cipher. The functions are pure, but the
files they live in are not. Importing them today also evaluates the did:webvh,
zcap and WAS transport modules, and through the `@interop/edv-client` barrel the
HTTP packages behind them. No call here ever reaches that code. The cost is
module evaluation and bundle size, not correctness. Install size does not change
under any of this, since both upstream packages keep their dependencies.

Draft because the work is upstream and none of it is scheduled. A standalone
package was considered and set aside. was-client's ARCHITECTURE.md records a
"Subpaths, not packages" decision (2026-08-22) whose revisit criteria this
package does not meet, since it wants the crypto packages and only wants the
transport out of the import graph. The same reasoning applies to wallet-core,
where this package is the only outside consumer of the pure functions. The route
is transport-free entry points in both packages. This item parks the consuming
half: repoint the imports once those entries exist.

The upstream work is tracked in the owning repos, filed 2026-09-18 in the same
pass that found WBU-2. Entry names are for the maintainer to settle.

- was-client WCL-111 to WCL-114: shipped in `@interop/was-client` 0.70.0 as the
  `@interop/was-client/edv/core` entry. This package's `src/` and tests import
  the ciphers, the epoch primitives and `EPOCH_CONFIGURATION_STATE_TYPE` from
  it, and the peer range is `>=0.70.0 <1.0.0`. The transport modules still load
  here through wallet-core, which imports the full `./edv` entry, until the
  wallet-core items below land.
- wallet-core WC-242 to WC-244: the small cuts in `keyring/kdf.ts`,
  `keyring/record.ts`, and the `keys` helpers (`rosterRecipientKid`,
  `unwrapUserKeyGenerations`, `userKeyAsRecipient`).
- wallet-core WC-245: move the ladder rung derivation out of
  `clientAnnex/ladder.ts`. This is the expensive cut, and
  `recoveryClientFromCode` loads the ceremony graph until it lands.
- wallet-core WC-246: landed on disk 2026-09-18 for `@interop/wallet-core`
  0.79.0, unreleased. The leaf entries are `./keyring/kdf`,
  `./keyring/recordEnvelope`, `./keys/userKey`, `./keys/userKeyGenerations`,
  `./unlock/standingClient`, `./unlock/ladderDerivation`, and
  `./recovery/recoveryCode`, held by an import-graph test. The recovery client
  is included, since WC-245 landed first.

Promote to `todo` when WC-246 is published. Acceptance at that point is an
import-graph test here, in the manner of was-client's
`test/node/import-graph.test.ts`, asserting that `src/` evaluates no transport
module. The recovery code path is exempt until WC-245 lands.

Promoted and closed 2026-09-19, once wallet-core 0.79.0 published. The recovery
code path is covered, since WC-245 landed before WC-246. One more upstream cut
was needed on the way: the four collection names the walk takes from
`@interop/wallet-core/space` came through a barrel that loads the was-client
transport graph (`provisioning.ts`, `deleteSpace.ts`), so wallet-core gained a
`./space/collections` leaf entry, unpublished as 0.79.1 at closing time. The
devDependency is a `link:` until it publishes (ARCHITECTURE.md, Current State).

---

### WBU-4: The export ceremony, code before Space list

- status: done (2026-09-20)
- priority: high
- labels: bundle, export, ceremony
- acceptance:
  - [x] `exportBundle` runs the ordered sequence and hands back the packed
        bundle, taking the wallet's code issuance, its Space listing and the
        server's per-Space export primitive as ports.
  - [x] The recovery code is issued before the Space list is read, so the bundle
        carries the unlock Space the code opens.
  - [x] A failed Space export fails the whole ceremony, naming the Space with
        the host's error as `cause`.
  - [x] A Space list naming no account Space refuses before any export runs.
  - [x] Node suite covers the order, both packed forms round-tripping through
        `readBundle` / `unpackRecoveryCode`, the failing export, the refusal and
        the abort.
  - [x] README usage snippet and the ARCHITECTURE layer map and invariant.

Context: the bundle codec could write a bundle but nothing here owned the order
a wallet has to write one in. Each wallet was left to assemble the sequence
itself, and getting it wrong is silent: list the account's Spaces before minting
the recovery code and the code's own unlock Space is not in the list, so the
bundle ships a code that opens a Space it does not carry. The order belongs
beside the codec that depends on it.

`discovered-from: freewallet FW-530`. The layering was settled in freewallet's
FW-531 walk-through (2026-09-15): the package owns the ceremony -- mint the
code, call the primitive per Space, assemble -- and the transport is a port, so
the app decides how the file reaches it. `src/bundle/exportBundle.ts` holds it.
The code string is never returned: it lives for the one `packRecoveryCode` call
and is dropped when the ceremony ends.

---

### WBU-5: Stream `writeBundle` instead of buffering the whole bundle

- status: done (2026-09-28)
- priority: medium
- labels: export, streaming

Context: `writeBundle` collects every Space archive with `collectBytes`, writes
each as a tar entry, and calls `pack.finalize()` before returning, with no
consumer attached. Nothing reads the pack while it is written, so the finished
bundle sits in the pack's own queue in memory, and a host that pipes it to a
file sees the file appear only once the whole export has finished. A backup of
an account with several large Spaces is therefore bounded by memory rather than
by disk, and the user gets no progress from the save itself.
`discovered-from: freewallet FW-530`.

The writer should hand the pack (or a stream over it) back before the entries
are written, and write each entry as the consumer drains: await the pack's drain
signal between entries so backpressure reaches the per-Space export, and report
a failure part way through by destroying the pack (`pack.destroy(err)`) so the
consumer sees the error rather than a truncated tar. A Space archive still has
to be collected before its own entry is written, since a tar header carries the
entry size, so the bound drops from the whole bundle to one archive.

The host halves matter for the acceptance: freewallet's save picker opens before
the run today precisely because the bundle is buffered, and a streaming writer
lets the picked file fill as the export proceeds.

- acceptance:
  - [x] `writeBundle` returns before its entries are written, and writes them as
        the consumer drains
  - [x] Backpressure reaches the per-Space export: an undrained consumer stops
        the next Space from being exported
  - [x] A per-Space failure destroys the pack, and the consumer sees that error
  - [x] The bundle's bytes are unchanged (the byte-reproducibility test still
        passes)
  - [x] The three host-facing comments corrected for FW-530 (`exportBundle.ts`,
        `writeBundle.ts`, freewallet's `backupExport.ts` and `saveStream.ts`)
        are updated to the streaming behavior
  - [x] `exportBundle` hands back a `ReadableStream<Uint8Array>` (or the package
        exports the AsyncIterable-to-ReadableStream adapter), so a host neither
        casts the pack's `unknown` chunks nor writes the adapter itself
        (freewallet's `streamFromPack` is the copy to delete)
  - [x] The writer bounds how many Space exports are in flight (a small fixed
        number ahead of the entry being written) rather than one at a time, so
        an account with many recovery codes is not strictly serial; the bound,
        not the host, decides, since the host's per-Space callback cannot see
        the consumer's backpressure

---

### WBU-8: Rename the sink port's "row" vocabulary to Resource

- status: done (2026-09-28)
- priority: high
- labels: migrate, sink, naming
- touches:
  - [x] wallet-backup: `src/migrate/sink.ts` (`AppCollectionRow` to
        `AppCollectionResource`, `importRow` to `importResource`, the `row`
        payload field to `json` on every sink method), and the walk's internal
        names (`RowCipher`, `OpenedRow`, `readRow`, `openRow`, `walkedRows`);
        README; CHANGELOG names the sink port change as breaking. Shipped: all
        renamed, "row" prose in `src/` and the tests reworded, README example
        and prose updated, breaking entry under 0.5.0.
  - [x] wallet-backup ARCHITECTURE.md (prose outside the Glossary) and AGENTS.md
        (a walk of the parties table). Shipped: ARCHITECTURE.md layer map,
        invariants 3 and 10, and the EDV contract paragraph. AGENTS.md
        unaffected (the parties table names only freewallet's own "import
        activity row").
  - [x] freewallet: `src/session/contentMigration.ts` (the sink), the
        `importAppCollectionRow` import function and its tests, plus its
        ARCHITECTURE/AGENTS files. Shipped: the sink and
        `importAppCollectionResource` with its tests, ARCHITECTURE.md, and
        `docs/architecture/session-persistence.md`; AGENTS.md unaffected (no old
        names); CHANGELOG entry under 0.44.0.
  - [x] dcw: no sink over the port yet; record the new names on DCW-80. Shipped:
        DCW-80's prose names the 0.5.0 port shape.
- acceptance:
  - [x] No identifier, JSDoc or README text in `src/migrate/` uses "row" for the
        migrated unit or its payload.
  - [x] Every sink method's JSON payload field is `json`; app collections take
        `{ json }` or `{ bytes }`.
  - [x] Node suite green under the new names.
  - [x] CHANGELOG entry, and README and ARCHITECTURE updated.

Context: the migration code calls the unit it migrates a "row" and also names
the parsed JSON payload field `row`. The two meanings collide exactly where the
sink contract distinguishes `{ row }` from `{ bytes }`, which makes WBU-6 and
WBU-7 hard to state. The Glossary now names the unit a Resource (the WAS spec's
word for the same thing) and the JSON payload `json`, with "row" on the avoid
list. The code and the rest of the docs still use the old names.

discovered-from: WBU-6, in its design review (2026-09-28). The names were signed
off by the user on 2026-09-28. Decision records keep their wording, since
records are superseded rather than rewritten. The host's "activity row" is
freewallet's own term and is out of scope. Landing this before WBU-6 and WBU-7
lets both be written against the new names.

---

### WBU-6: Migrate chunked Resources instead of refusing them

- status: done (2026-09-28)
- priority: medium
- labels: migrate, chunks, encryption
- design: designs/WBU-6-chunked-resources.md (reviewed 2026-09-28; Q1, Q2 and
  the option name settled 2026-09-28)
- design-approved: 2026-09-28
- touches:
  - [x] wallet-backup: `src/migrate/collectionWalk.ts`,
        `src/migrate/migrateBundle.ts`, the sink port's documented Resource
        meaning, and the narrowing of `ChunkedResourceUnsupportedError` --
        shipped: the two-pass walk with a chunk source per chunk directory,
        result-type routing (`Blob` to `bytes` under its sealed type),
        `openChunked` for encrypted app collections only, and the `sink.ts`,
        `report.ts` and `errors.ts` JSDoc
  - [x] wallet-backup: `package.json` was-client devDependency and peer range
        move to the release carrying the chunk source;
        `test/probe/transportClosure.mjs` forbids the edv-client root and
        `HttpsTransport`; README and `sink.ts` Resource-shape text -- shipped:
        peer range `>=0.80.0`, the devDependency on the published `^0.80.0`, the
        two probe entries, README and `sink.ts` text
  - [x] wallet-backup ARCHITECTURE.md (invariants 3, 7 and 8) and AGENTS.md (the
        sink port change is a walk of the parties table); decision 0002 amended
        with the bytes-Resource identity rule (done 2026-09-28), and 0003
        recording chunk reassembly in was-client (done 2026-09-28) -- shipped:
        ARCHITECTURE.md invariants 3, 4, 7, 8 and 10, an ownership heuristic
        citing 0003. AGENTS.md text is unchanged; the parties-table walk is the
        freewallet and dcw entries below
  - [x] was-client: let the cipher's `decrypt` take a caller-supplied
        `chunkSource` in place of a request context (`src/edv/docCipher.ts`,
        `src/edv/EdvCodec.ts`), a read-side chunk-binding check, `blobBytes`
        exported from `./edv/core`, a quota error that keeps its name through
        `#chunkedWriteFailed`, and a write-by-id path for chunked plans (design
        Q1), plus its ARCHITECTURE/AGENTS files -- shipped in 0.80.0 (WCL-120):
        `chunkSource`, the chunk-binding check, `blobBytes`,
        `QuotaExceededError` through a chunked write, `Resource.put()` of a
        chunk plan at a new id, `isPendingStub`; ARCHITECTURE.md and the
        Glossary updated
  - [x] freewallet: `importAppCollectionResource` accepts a `bytes` Resource for
        an encrypted collection, written at its archived id (design Q1), with
        pending-stub reaping, `snapshotAppCollection` records held bytes
        Resources by id, `wasRemoteStore.ts`, `contentMigrationCauseKey.ts` and
        the en/es cause strings, plus its ARCHITECTURE/AGENTS files -- shipped
        (FW-583, uncommitted): the by-id put with `ifNoneMatch`, byte compare on
        412, pending-stub delete and retry, the snapshot recording bytes
        Resources by id, `QuotaExceededError` surfacing, a same-tab
        `ContentMigrationInProgressError`, the cause keys and en/es strings,
        ARCHITECTURE.md and `docs/architecture/session-persistence.md`
  - [x] dcw: no sink over `appCollections` yet (DCW-80 covers the standard
        imports only); record the requirement there, plus its
        ARCHITECTURE/AGENTS files -- shipped: DCW-80 lists the app collection
        requirements (the `{ json }` or `{ bytes }` shape, by-id identity, stub
        reaping, `QuotaExceededError`, the React Native `Blob` question) with
        FW-583 as the reference sink. ARCHITECTURE.md and AGENTS.md unaffected
        (neither describes the migration sink port)
  - [x] space-archive: state that a chunk directory's files are packed together,
        in its ARCHITECTURE.md -- shipped: the "Archive layout" section states
        it of `packDirectory`, and that the profile spec requires it
  - [x] portable-wallet-profile-spec: the per-Space archive's entry order states
        chunk directory contiguity (design Q2) -- shipped: the bundle Layout
        section requires a writer to keep a chunk directory's entries together,
        and lets a reader treat a Resource whose directory is split as
        unreadable; noted on PWP-4
  - [x] unaffected: was-teaching-server (both backends hand
        `@interop/space-archive` one nested entry per chunk directory, holding
        its chunk files and sidecars, so `packDirectory` emits it contiguously;
        confirmed 2026-09-28)
  - [x] unaffected: was-react and was-sync (`chunkSource` sits on `EdvDocCipher`
        only, not on the shared `DocCipher`; neither matches on the
        chunked-write error names was-client 0.80.0 changed, and neither writes
        chunked documents; confirmed 2026-09-28)
  - [x] unaffected: encrypted-collections-spec (the chunked envelope text
        requires no WAS route for chunks, and export and import already carry a
        Resource's chunks with it; confirmed 2026-09-28). The spec does not
        state the reader-side chunk-to-envelope binding check was-client 0.80.0
        runs; that is a possible clarification, not a blocker
- acceptance:
  - [x] An approved design doc settles where reassembly happens (the walk, the
        cipher, or the sink) and how it keeps invariant 3.
  - [x] A chunked Resource in an encrypted collection migrates through the sink
        and is counted as imported, not as unopenable.
  - [x] A chunked Resource in a plaintext app collection or a standard
        collection stays refused under `ChunkedResourceUnsupportedError`, since
        only the encrypted chunked envelope has a defined reassembly.
  - [x] A chunked Resource whose chunks are missing or unreadable is reported by
        a named cause, and the rest of the collection still migrates.
  - [x] Node suite covers the design doc's test plan, and the tests at
        `test/node/migrate.test.ts` that expect the refusal are split.
  - [x] CHANGELOG entry, and README and ARCHITECTURE updated.

Context: a backup bundle carries chunked Resources. The export copies each Space
archive verbatim, and the archive keeps a chunked Resource's chunk files in
their own directory. The migration walk does not open them. It notes which
Resources are chunked, skips them, and counts each one as unopenable with
`ChunkedResourceUnsupportedError`. A user who restores through migration
silently loses those Resources, which are likely the large ones (files and
media), and the only sign is a count in the report.

The refusal was a scoping choice made in freewallet's FW-541 content-migration
design (review 2026-09-16), which lists chunked Resources as out of scope. No
follow-up item was filed there or here. The blocker named at the time is in
was-client: `createEdvDocCipher` reassembles a chunked envelope only when built
with a `spaceId` and given a request context, because it fetches the chunk
Resources over WAS routes. Called without a context, as the walk calls it,
`decrypt` throws `EncryptionError` (was-client `src/edv/EdvCodec.ts:986-994`).
In an archive the chunks are local files, so the cipher needs a way to take
chunk bytes from the caller.

The survey (`src/migrate/archiveSurvey.ts:124`) already finds the chunk
directories, and the walk skips the matching Resources at
`src/migrate/collectionWalk.ts:199`.

The reassembly itself exists upstream and is reused, not rewritten. edv-client's
`EdvClientCore.getStream` (`src/EdvClientCore.ts:506`) pulls each chunk through
`transport.getChunk({ docId, chunkIndex })` and pipes the chunks through the
cipher's decrypt stream. The transport is pluggable. was-client's
`EdvCodec#readChunked` (`src/edv/EdvCodec.ts:970`) drives it, and checks that
the chunk count is the sealed one and that the chunks are addressed by the
envelope's AEAD-bound `was.resource` id. Today it builds the transport only from
a request context, which means a WAS route. The was-client change is to accept a
chunk source instead, such as an archive-backed `getChunk`, so the same checks
cover the archive path. did-cli-typescript's `decryptChunks`
(`src/edv/stream.ts:148`) is a local copy of the same logic. It calls
`minimal-cipher` directly, skips those checks, and reads its own directory
layout, so it is not the source to reuse.

Two questions go to the design. First, the archive is one-shot, and a chunk
directory can sit before or after its Resource's representation file, while
`getChunk` is called once per index in order. The walk has to reach a Resource's
chunks when it reaches its representation. Second, a reassembled Resource can be
large, and invariant 3 forbids holding it whole. Upstream reads already hand the
Resource over whole: `#readChunked` buffers the decrypt stream into one `Blob`.
Handing the sink a whole Resource and rewording invariant 3 is the leading
option. A streamed Resource in the sink port is the alternative, and it would
reach every sink in the parties table.

### WBU-7: Hand small encrypted binary Resources to the sink as bytes

- status: done (2026-09-28)
- priority: high
- labels: migrate, encryption, bug
- touches:
  - [x] wallet-backup: `src/migrate/collectionWalk.ts` routes a `Blob` decrypt
        result as `bytes` under `blob.type`; `sink.ts` and README Resource-shape
        text; CHANGELOG names the sink port change as breaking -- shipped with
        WBU-6's walk (0.5.0)
  - [x] wallet-backup ARCHITECTURE.md and AGENTS.md (a walk of the parties
        table) -- shipped: the Glossary's Resource entry and invariant 4's
        `blobBytes` rule. AGENTS.md text is unchanged; the parties-table walk is
        the freewallet and dcw entries below
  - [x] was-client: export `blobBytes` from `./edv/core` -- shipped in 0.80.0
  - [x] freewallet: `importAppCollectionResource` accepts a `bytes` Resource for
        an encrypted collection, with a content identity for it; the
        `decryptEnvelope` and `recordEnvelope.ts` comments, plus its
        ARCHITECTURE/AGENTS files -- shipped with WBU-6's freewallet entry
        (FW-583): identity is the archived id, comments corrected
  - [x] dcw: record the requirement for its future `appCollections` sink --
        shipped with WBU-6's dcw entry (DCW-80)
- acceptance:
  - [x] An encrypted app-collection Resource that decrypts to a `Blob` reaches
        the sink as `bytes` under its sealed content type.
  - [x] Two different small encrypted images in one collection both migrate.
  - [x] Node suite covers both, and a re-run of each is `skipped`. (The
        wallet-backup suite covers both; the re-run's `skipped` is covered by
        freewallet's `storageManager.appImport.test.ts`.)
  - [x] CHANGELOG entry, and README and ARCHITECTURE updated.

Context: an encrypted Resource under 512 KiB whose payload is binary or text
decrypts to a `Blob`, not JSON. The migration walk hands whatever the cipher
returns as `row`, under `application/json`. freewallet's content identity of any
`Blob` is the cid of `{}`, so the first such Resource in a collection is
accepted and every later one is reported `skipped`. Those Resources are lost,
and the report says they were already there. Small photos and documents from a
connected app are affected today.

discovered-from: WBU-6, in its design review (2026-09-28). The walk side is
`collectionWalk.ts:217-223`; was-client's `#fromDocument` returns the `Blob`
(`EdvCodec.ts:1655-1682`); freewallet's identity is `contentCid(row)` at
`storageManager.ts:6451`. The re-run identity rule for a bytes Resource is the
same open question as WBU-6's Q1, and needs core-contributor sign-off before it
is coded. WBU-6's design restates this fix so it does not depend on WBU-7
landing first. WBU-7 waits only on the Q1 answer, not on WBU-6's implementation.

Q1 was settled 2026-09-28: a bytes Resource in an encrypted collection is
written at its archived `resourceId`, and that id is its identity. WBU-7 shares
WBU-6's was-client write-by-id path.
