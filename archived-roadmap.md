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
