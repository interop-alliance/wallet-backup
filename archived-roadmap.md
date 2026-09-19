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
