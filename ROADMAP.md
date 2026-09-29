# Wallet-Backup (open items)

nextAvailableId: 9

Status as of 2026-09-18. Uses the formalized item structure shared with the
freewallet and was-teaching-server roadmaps.

Scope: open work items only. This document tracks the **remaining** items;
completed items move verbatim to [archived-roadmap.md](archived-roadmap.md) as
they land, so WBU-N references keep resolving (CHANGELOG.md remains the record
of what landed).

## Item format

Each work item is a `### WBU-N: Title` heading followed by a field block and
free prose context. Ids are permanent and never reused; new items take the next
unused number regardless of section. Statuses: `todo`, `in-progress`, `draft`
(no actionable done-state yet -- blocked externally or a parking record); `done`
items move to [archived-roadmap.md](archived-roadmap.md) once shipped. Full
conventions live in [AGENTS.md](AGENTS.md) under "Roadmap & Task Conventions".

---

### WBU-6: Migrate chunked Resources instead of refusing them

- status: in-progress
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
        peer range `>=0.80.0`, the devDependency on `link:../was-client` until
        0.80.0 publishes, the two probe entries, README and `sink.ts` text
  - [x] wallet-backup ARCHITECTURE.md (invariants 3, 7 and 8) and AGENTS.md (the
        sink port change is a walk of the parties table); decision 0002 amended
        with the bytes-Resource identity rule (done 2026-09-28), and 0003
        recording chunk reassembly in was-client (done 2026-09-28) -- shipped:
        ARCHITECTURE.md invariants 3, 4, 7, 8 and 10, an ownership heuristic
        citing 0003, and the Current State label for the was-client link.
        AGENTS.md text is unchanged; the parties-table walk is the freewallet
        and dcw entries below
  - [ ] was-client: let the cipher's `decrypt` take a caller-supplied
        `chunkSource` in place of a request context (`src/edv/docCipher.ts`,
        `src/edv/EdvCodec.ts`), a read-side chunk-binding check, `blobBytes`
        exported from `./edv/core`, a quota error that keeps its name through
        `#chunkedWriteFailed`, and a write-by-id path for chunked plans (design
        Q1), plus its ARCHITECTURE/AGENTS files
  - [ ] freewallet: `importAppCollectionResource` accepts a `bytes` Resource for
        an encrypted collection, written at its archived id (design Q1), with
        pending-stub reaping, `snapshotAppCollection` records held bytes
        Resources by id, `wasRemoteStore.ts`, `contentMigrationCauseKey.ts` and
        the en/es cause strings, plus its ARCHITECTURE/AGENTS files
  - [ ] dcw: no sink over `appCollections` yet (DCW-80 covers the standard
        imports only); record the requirement there, plus its
        ARCHITECTURE/AGENTS files
  - [ ] space-archive: state that a chunk directory's files are packed together,
        in its ARCHITECTURE.md
  - [ ] portable-wallet-profile-spec: the per-Space archive's entry order states
        chunk directory contiguity (design Q2)
  - [ ] was-teaching-server: both backends already pack chunk directories
        contiguously; confirm and resolve as unaffected
  - [ ] was-react and was-sync: the option stays off the shared `DocCipher`
        interface; confirm and resolve as unaffected
  - [ ] encrypted-collections-spec: confirm the chunked envelope needs no change
        for archive-local reassembly, or resolve as unaffected
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

- status: todo
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
  - [ ] was-client: export `blobBytes` from `./edv/core`
  - [ ] freewallet: `importAppCollectionResource` accepts a `bytes` Resource for
        an encrypted collection, with a content identity for it; the
        `decryptEnvelope` and `recordEnvelope.ts` comments, plus its
        ARCHITECTURE/AGENTS files
  - [ ] dcw: record the requirement for its future `appCollections` sink
- acceptance:
  - [x] An encrypted app-collection Resource that decrypts to a `Blob` reaches
        the sink as `bytes` under its sealed content type.
  - [x] Two different small encrypted images in one collection both migrate.
  - [ ] Node suite covers both, and a re-run of each is `skipped`. (The
        wallet-backup suite covers both; a re-run's `skipped` is the freewallet
        sink's test.)
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
