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
