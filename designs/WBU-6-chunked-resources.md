# WBU-6: Migrate chunked Resources instead of refusing them (design)

- item: WBU-6
- status: approved
- approved: 2026-09-28
- wire-level decisions contained: none new on the wire. Section 5 lists the sink
  port contract change, the reused error names, and the re-run identity rule for
  a bytes Resource, all for sign-off.
- decision records extracted: 0002 amended (the bytes-Resource identity rule),
  0003 (chunk reassembly lives in was-client)
- review: adversarial pass 2026-09-28 (section 9). The forks in section 8 were
  settled 2026-09-28 (Q1 option (a), Q2 contiguity in the spec, `chunkSource`).

## 1. Problem and scope

A backup bundle carries chunked Resources, but the migration walk refuses them.
`archiveSurvey.ts:124` records each collection's chunk directories, and
`collectionWalk.ts:199` skips the matching Resources. Each one is counted as
unopenable under `ChunkedResourceUnsupportedError`. In practice these are the
large binary Resources: a connected app's photos, PDFs and media. was-client
writes any binary over 512 KiB (`DEFAULT_MAX_BLOB_BYTES`, `EdvCodec.ts:144`) as
a chunked envelope in 1 MiB plaintext chunks. A user who restores through the
migration walk loses them, and only a count in the report shows it.

This design migrates chunked Resources in encrypted app collections. The walk
reassembles each one through was-client's existing reader and hands the sink the
plaintext bytes under the Resource's sealed content type.

The review found a related defect that ships today (section 9, R3). A small
encrypted binary or text Resource already decrypts to a `Blob`, and the walk
hands it as `json` under `application/json`. freewallet's content identity of
any `Blob` is the cid of `{}`, so the second such Resource in a collection is
reported `skipped` and lost. The sink contract change in section 5 covers both
cases, since it routes every `Blob` result as `bytes`. WBU-7 tracks the
small-Resource fix. It needs the same bytes-Resource identity rule (Q1), so Q1
is settled before either item is coded, and both use one rule.

Out of scope:

- Chunked Resources in plaintext collections. The WAS server stores chunks for
  any Resource as opaque bytes, but the only defined chunk framing is the
  encrypted-collections chunked envelope (encrypted-collections-spec
  `spec.md:1172-1215`). A plaintext chunked Resource has no reassembly rule to
  follow, so it stays refused under `ChunkedResourceUnsupportedError`.
- Chunked Resources in the four standard collections. The wallets write those
  Resources as small JSON and never chunk them, and their import functions take
  a parsed JSON payload. One found there stays refused under the same error.
- A streamed Resource in the sink port (section 6).
- The export side. It already copies chunk directories verbatim.

## 2. Invariant inventory

- **Invariant 3, "Nothing large is held whole."** Deliberately changed. The walk
  already holds the account Space archive whole (`migrateBundle.ts:156`,
  `accountSpaceArchive` returns a `Uint8Array`), and it holds one Resource on
  top of it. A reassembled chunked Resource is still one Resource, but it can
  run to tens of MiB. The copies of one Resource, in order:
  - the chunk files as `entry.bytes()` copies out of the archive (JWE JSON,
    about 1.35 times the plaintext), held in the group map;
  - the decrypted parts that `streamToBlob` collects (`EdvCodec.ts:1719-1737`);
  - the `Blob` built from those parts;
  - the `Uint8Array` handed to the sink.

  The chunk source deletes each map entry as it serves it, so the group map
  shrinks as the parts grow. That is safe because the `KeyUnwrapError` fallback
  to the next generation happens before any chunk is read, and a chunk-stage
  error never falls back (`collectionWalk.ts:74-78`). The peak is then about two
  copies of the plaintext plus one chunk, at the `new Blob(parts)` step and
  again at the `Blob` to `Uint8Array` copy. Sealed values do not bound this,
  since anyone holding the public epoch key can seal a count (section 5, "Trust
  root"). The real per-Resource bound is the size of the largest chunk group the
  archive carries. The ARCHITECTURE.md edit restates invariant 3 in three
  places:
  - the invariant text itself: a chunked Resource in an encrypted collection is
    reassembled and handed over whole, so the per-Resource bound is the largest
    such Resource;
  - the sentence "buffers nothing per collection but the small documents
    `archiveSurvey.ts` gathers" (`ARCHITECTURE.md:65-68`), which gains the
    per-collection map of chunked envelopes. A chunked envelope is a few hundred
    bytes. The map holds envelope bytes only for ids whose envelope failed under
    an empty chunk source with `NotFoundError` in the first pass (section 5,
    step 1). An envelope rewritten small beside a stale chunk directory opens in
    the first pass and is not held, so the map stays small;
  - the `collectionWalk.ts:9-10` header ("holds one row at a time").

  The sink's own copies (section 5, "freewallet sink") come on top of these.

- **Invariant 4, "The codecs are isomorphic."** Touched. React Native's `Blob`
  implements neither `text()` nor `arrayBuffer()` (was-client
  `src/internal/blob.ts:4-14`), which is why was-client reads every `Blob`
  through `blobBytes`. The walk reads the reassembled `Blob` through that
  helper, which was-client exports from `./edv/core` for this (an in-house
  export change). A Chromium test cannot catch a regression here, so the walk
  has no `blob.arrayBuffer()` call at all. Reading is only half of it.
  was-client builds the `Blob` from `Uint8Array` parts (`EdvCodec.ts:1679`,
  `:1737`), and stock React Native's `Blob` constructor is reported to refuse
  such parts. That claim is unverified here, and dcw has no `Blob` polyfill. If
  it holds, every chunked and small binary Resource throws inside was-client on
  dcw before `blobBytes` runs. This is a was-client isomorphism question as much
  as this package's (section 8). Browser and Node `Blob` also lowercase the type
  and blank a non-ASCII one, so "the sealed content type" is the type as the
  platform's `Blob` normalizes it.
- **Invariant 7, "The migration walk issues no request, and the package
  evaluates no transport module."** Upheld, with its wording amended. The chunk
  source is an in-memory function over bytes already read from the archive.
  was-client wraps it in a subclass of edv-client's abstract `Transport`,
  imported from `@interop/edv-client/core`, which `EdvCodec.ts:70` already
  imports and whose `Transport.ts` has only type imports. `WasTransport` and
  `transportFactory.js` stay out of the import graph, and the ciphers are still
  built without a `spaceId`. The sentence "so was-client constructs no
  transport" (`ARCHITECTURE.md:103-104`) becomes false, so it is reworded: the
  only transport the walk's graph reaches serves chunks from in-memory bytes.
  Two gaps in the probe are closed:
  - `test/probe/transportClosure.mjs` gains `/edv-client/dist/index.js` and
    `/edv-client/dist/HttpsTransport.js` in `FORBIDDEN_MODULES`. Today an import
    of the edv-client root passes it.
  - The walk never imports `NotFoundError` from the was-client root, which the
    probe forbids. The missing-chunk error is raised inside was-client (section
    5).

  The probe runs against the installed was-client, so it covers the new code
  only once the devDependency moves to the release that carries it (section 5,
  "Versions").

- **Invariant 8, "Key material does not outlive the walk, as far as it can be
  scrubbed."** Touched. minimal-cipher unwraps a fresh content-encryption key
  for every chunk and does not zero it (`DecryptTransformer.ts:152-175`). A
  chunked Resource therefore leaves one unscrubbed content key per chunk, where
  a single-envelope Resource leaves one. The invariant's list of what cannot be
  scrubbed (`ARCHITECTURE.md:128-133`) gains the per-chunk content keys as an
  accepted residue.
- **Invariant 10, "The walk refuses early or counts."** Upheld, with three
  requirements the draft did not state:
  - Every step the walk runs on a chunked Resource before the sink sits inside
    the per-Resource open catch: the envelope parse, the chunk source, the
    decrypt, the `Blob` read. A throw there counts the Resource under its cause
    name, except an abort, which is rethrown. `importResource` stays in its own
    catch, as today, so a `QuotaExceededError` still stops the walk.
    `migrateBundle.ts:285-296` wraps the walk only in `try`/`finally`, so a
    throw that escapes it loses the whole report.
  - A stray chunk directory (no representation beside it) stays counted, as it
    is today. A directory whose Resource the first pass already counted is
    ignored, so no Resource is counted twice. A held envelope whose directory
    yields no chunk file is opened at the end of the pass with an empty source,
    so it is counted too.
  - `QuotaExceededError` from the sink still ends the walk only if the sink
    surfaces that name. was-client's chunked write wraps a 507 on a chunk or on
    the final envelope update in `EncryptionError`, with the 507 only as its
    `cause` (`EdvCodec.ts:833-857`). Section 5 ("freewallet sink") requires the
    sink to rethrow the quota error under its own name.
- **Decision 0002, "Skip existing by content identity."** Touched, and its
  Revisit Criterion 2 is triggered (0002:78-80). A bytes Resource in an
  encrypted collection carries no natural identity. freewallet's
  `appRowIdentity` covers only a JSON payload (`storageManager.ts:372-378`), and
  the encrypted write path mints a fresh id per write. A fifth identity rule is
  needed (section 8, Q1). 0002 is amended in place with it.
- **was-client's chunked-read checks** (`EdvCodec#readChunked`,
  `EdvCodec.ts:970`). Leaned on, with a gap stated plainly. The chunk count is
  the sealed one, and the source is asked for chunks of the envelope's
  AEAD-bound `was.resource` id. The source receives that `docId`, and the walk
  refuses a `docId` other than the group's `resourceId`. The reader does not
  check a chunk's own protected header against the envelope's binding, though.
  The writer puts the binding into every chunk's AAD (`EdvCodec.ts:733-737`),
  but `getStream` and minimal-cipher's `DecryptTransformer` accept each chunk
  under its own header and its own wrapped key. So a genuine chunk of Resource
  B, placed in A's directory, decrypts as part of A. Section 5 adds the
  read-side check in was-client.
- **space-archive's pack order.** Leaned on. `packDirectory`
  (`space-archive/src/archive/exportTar.ts:143-170`) emits a chunk directory's
  files together, straight after the directory entry. The teaching server's
  filesystem and postgres backends both do (`filesystem.ts:1606-1626`,
  `postgres.ts:4045-4080`). Nothing states this as a property, and the position
  of a chunk directory relative to its Resource's representation file is
  incidental (`archive.test.ts:316-353` packs one before the representation; the
  filesystem backend packs them after). The design depends on contiguity and on
  nothing else about the order. The per-Space archive's entry order is
  profile-spec text that "this version of the profile does not yet carry"
  (portable-wallet-profile-spec `spec.md:271-273`). So stating contiguity only
  in space-archive's ARCHITECTURE.md leaves a second exporter free to split a
  directory. Section 8, Q2 carries this.

Checked and untouched: invariants 1 and 2 (the walk only reads archive bytes),
5, 6 and 9.

## 3. Consumer enumeration

Produced by grepping wallet-backup, was-client, was-react, was-sync, freewallet
and dcw for `ChunkedResourceUnsupportedError`, `chunked`,
`AppCollectionResource`, `importAppCollectionResource`, `readChunked`,
`DocCipher`, `ResourceCodec`, `openResource` and `onProgress`, and by reading
the sink port's implementers from the AGENTS.md parties table and
space-archive's parties table.

wallet-backup:

- `src/migrate/archiveSurvey.ts` -- unchanged. It still gathers the chunked id
  set per collection.
- `src/migrate/collectionWalk.ts` -- changed (section 5). Its `ResourceCipher`
  type (`:33-35`) gains the chunk source option.
- `src/migrate/migrateBundle.ts:280` -- passes whether the collection is an
  encrypted app collection, so the walk knows which chunked Resources it may
  open.
- `src/migrate/sink.ts` `AppCollectionResource` -- the type is unchanged. Its
  JSDoc changes (`:12-17`, `:176-177`, "always `application/json`"). That is a
  change to the sink port contract (section 5).
- `src/errors.ts` `ChunkedResourceUnsupportedError` -- kept, with a narrower
  meaning: a chunked Resource outside an encrypted app collection.
- `src/migrate/report.ts` -- code unchanged. New causes are counted by name, as
  now. Its JSDoc at `:19` ("the Resource is chunked") is updated.
- README.md -- "An encrypted collection's Resource arrives decrypted as `json`,
  under `application/json`" is updated with the sink contract.
- `package.json` -- the was-client devDependency (`^0.77.0`) and peer range
  (`>=0.73.0 <1.0.0`) move to the release that carries the chunk source (section
  5, "Versions").
- `test/probe/transportClosure.mjs` -- gains the two edv-client entries (section
  2).
- `test/node/migrate.test.ts:652` and `:1165` -- these are the standard
  collection and plaintext collection refusals, and they stay as they are. The
  encrypted-app-collection cases are new tests. The fixture at `:255` builds a
  chunk directory with no envelope, which now exercises the stray path.
- `test/browser/` -- `bundle.spec.ts` only packs and reads, and never runs the
  walk. The browser case is a new migration spec (section 7).

was-client:

- `src/edv/docCipher.ts:382` `EdvDocCipher.decrypt`, `EdvCodec#decode` and
  `#readChunked` -- gain the chunk source option (section 5).
- `src/sync/types.ts:211-232` `DocCipher` and `src/codec.ts:369-373`
  `ResourceCodec.decode` -- unchanged in shape. The option sits on the EDV types
  only (section 5). The `DocCipher` JSDoc on context semantics is updated, since
  a context is no longer the only way to read a chunked envelope.
- `src/internal/blob.ts` `blobBytes` -- exported from `./edv/core` (section 2,
  invariant 4).
- `src/edv/EdvCodec.ts:715-722` `#transportFor` error text and ARCHITECTURE.md
  (`:402-405`, `:572-573`, invariant 10 at `:823-838`) -- the statement that a
  codec without a `spaceId` refuses the chunked path is narrowed.

Other repos:

- was-react `src/storage/docCipher.ts:68` derives its options from
  `Parameters<ClientDocCipher['decrypt']>[0]` and destructures only
  `{ id, envelope }` (`:127`). Unaffected while the option stays off the shared
  `DocCipher` interface.
- was-sync `conflictHandler.ts:183` exports
  `ConflictDecrypt = DocCipher['decrypt']`. Unaffected for the same reason.
- freewallet `src/stores/storageManager.ts:6403-6481`
  `importAppCollectionResource` -- changed. It refuses a bytes body for an
  encrypted collection today (`:6424-6427`). Its encrypted branch re-seals
  through a context-less `DocCipher.encrypt` under the default `'content'` id
  derivation (`:6227-6233`, `:6457-6464`), and was-client refuses a chunked
  write on that route (`docCipher.ts:318-326`, `EdvCodec.ts:584-596`). A write
  by id refuses a chunk plan too (`src/internal/write.ts:297-309`). So the sink
  needs a write route the draft did not have (section 8, Q1).
- freewallet `snapshotAppCollection` (`storageManager.ts:6348-6372`) and
  `decryptEnvelope` (`:291-336`) -- changed. The snapshot decrypts held
  Resources with no context, so a held chunked Resource throws and is left out.
  Its comment ("only a chunked document decrypts to a `Blob`, and no wallet
  collection stores one", `:304`, also `src/session/recordEnvelope.ts:227`) is
  false today for small binaries.
- freewallet `wasRemoteStore.ts` -- its client has a no-op keystore
  (`:708-714`), so an encrypted write handle needs the per-handle encryption
  override that `declareCollectionIndexes` uses. Depends on Q1.
- freewallet `src/lib/contentMigrationCauseKey.ts:18-36` and the locale strings
  (`en.json:775`, `es.json:775`) -- changed. The chunked string ("The item was
  stored in parts, which the import does not reassemble") is wrong for the cases
  it still covers, and the new causes (`NotFoundError`, `EncryptionError`,
  `DataError`, a plain `Error` from Node's AEAD, `QuotaExceededError` from a
  chunked write) need mappings. Unmapped names render as "Unexpected: {{name}}."
- freewallet `src/session/contentMigration.ts:198` `importResource` --
  unchanged. It already forwards `bytes` when present.
- dcw -- no sink yet. DCW-80 (`dcw/_spec/ROADMAP.md:428`) covers only the four
  standard imports and no `appCollections`, so nothing changes today. When dcw
  adds `appCollections`, it must accept `bytes` for an encrypted collection.
  DCW-80's acceptance ("report matches freewallet's for the same bundle")
  already diverges on app collections, and this widens that gap. A note goes on
  DCW-80.
- portable-wallet-profile-spec and was-teaching-server -- parties to
  space-archive's layout contract, reached through the contiguity dependency
  (section 8, Q2).

## 4. Interaction matrix

Rows are existing flows and states. Columns are what this design introduces.

| Flow or state                                       | Chunked Resource, encrypted app collection                                                                                                                                                                                                                                      | Chunked Resource, plaintext or standard collection | Chunk missing or unreadable                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| First run into an empty account                     | changed: reassembled, handed as `bytes`, counted by the sink's outcome                                                                                                                                                                                                          | fine: refused as today                             | changed: counted unopenable under the cause name                 |
| Re-run after a partial first run                    | changed: written at the archived id (Q1). A 412 compares the held bytes, and equal bytes count `skipped`                                                                                                                                                                        | fine                                               | fine: counted again, as any unopenable Resource                  |
| Re-run after a torn chunked sink write              | changed: the stub and its partial chunks sit at the archived id. The sink recognizes the stub, deletes it and rewrites the Resource (section 5)                                                                                                                                 | fine                                               | not reached                                                      |
| Resource under a generation this secret cannot open | fine: the envelope fails in `openResource` with `KeyUnwrapError` before any chunk is read (`EdvCodec.ts:917-941`)                                                                                                                                                               | fine                                               | not reached                                                      |
| Chunk sealed to another epoch                       | changed: the chunk's `was.epoch` differs from the envelope's, so the chunk-binding check refuses it under `EncryptionError`. `KeyMissError` is reached only by a hand-forged header                                                                                             | not reached                                        | same cell                                                        |
| Chunk corrupted, or moved to another index          | changed: the AEAD or the index-bound AAD fails in minimal-cipher. The Resource counts under `DataError` where the platform decrypt returns null, and under a plain `Error` in Node, whose AEAD throw minimal-cipher does not rename (`DecryptTransformer.ts:64-68`, `:114-119`) | not reached                                        | same cell                                                        |
| Chunk from another Resource in this directory       | changed: refused by the new chunk-binding check in was-client, counted under `EncryptionError`                                                                                                                                                                                  | not reached                                        | same cell                                                        |
| Torn source write: pending stub, partial chunk dir  | changed: the envelope records no sealed count, and the Resource counts under `EncryptionError` (`EdvCodec.ts:976-982`) before any chunk is read. With an empty directory it is opened at pass end, with the same result                                                         | fine: refused as today                             | same cell                                                        |
| Chunk dir beside a non-chunked envelope             | changed: decrypt returns `Json` or a small `Blob`, and the walk routes it by the result type (`json` or `bytes`). The directory is ignored                                                                                                                                      | fine: refused as today                             | not reached                                                      |
| Chunked envelope, no chunk dir in the archive       | changed: every Resource of an encrypted app collection gets a chunk source, empty when no directory exists, so it counts under `NotFoundError`                                                                                                                                  | not reached                                        | same cell                                                        |
| Stray chunk dir, no representation                  | fine: counted unopenable under `NotFoundError`, one per directory                                                                                                                                                                                                               | fine: counted as today                             | same cell                                                        |
| Chunk file unparseable, sidecar, or duplicate idx   | changed: only `representation` files with a valid index are buffered. Sidecars and bad names are skipped. A later duplicate index is skipped                                                                                                                                    | not reached                                        | a gap left by a skipped file counts under `NotFoundError`        |
| Abort signal                                        | changed: checked before each chunked Resource and inside the chunk source on each call. The open catch rethrows when the signal is aborted, so the walk throws the signal's reason and does not count the Resource. A sink's upload in progress is not interrupted (no signal)  | fine                                               | fine                                                             |
| `QuotaExceededError` from the sink                  | changed: ends the walk only if the sink rethrows the 507 under that name. was-client wraps it in `EncryptionError` today (section 5)                                                                                                                                            | fine                                               | not reached                                                      |
| Ten consecutive sink failures                       | fine: chunked Resources count toward the run like any other                                                                                                                                                                                                                     | fine                                               | fine: unopenable Resources do not count toward the run, as today |
| Walk stops in the first pass                        | changed: chunked envelopes not yet attempted are not counted, like ordinary Resources after a stop. The report's stop names why                                                                                                                                                 | fine: counted upfront as today                     | not reached                                                      |
| `onProgress` index                                  | changed: chunked Resources are reported after the collection's other Resources, in chunk-directory order. `onProgress` carries no total, so nothing drifts                                                                                                                      | fine: counted first, as today                      | same as its column                                               |
| Chunk directory split across the archive            | refused: the second pass sees only this collection's chunk entries, so only another chunk directory can split one. The first fragment counts under `NotFoundError`, and its envelope leaves the map, so later fragments count as strays                                         | fine                                               | same cell                                                        |
| Hostile chunk count (many tiny forged chunks)       | accepted risk: one X25519 derivation per chunk, bounded by archive size. The abort check in the source makes it interruptible                                                                                                                                                   | not reached                                        | same cell                                                        |
| Concurrent second migration run                     | not supported: a run could reap the other's stub mid-upload. The sink runs one migration at a time (section 5)                                                                                                                                                                  | fine                                               | not reached                                                      |

## 5. Design

### was-client

`EdvDocCipher.decrypt` takes one new option beside `context`:

```ts
async decrypt({
  id,
  envelope,
  context,
  chunkSource
}: {
  id: string
  envelope: Json
  context?: CodecRequestContext
  chunkSource?: (options: {
    docId: string
    chunkIndex: number
  }) => Promise<IEDVChunk | undefined>
}): Promise<Json | Blob>
```

The option sits on `EdvDocCipher` and the EDV codec only. The shared `DocCipher`
interface (`src/sync/types.ts`) and `ResourceCodec.decode` keep their shape, so
was-react, was-sync, `plaintextCipher.ts` and `refreshingDocCipher.ts` see no
change. The EDV doc cipher holds its codec as `EdvCodec`, not as
`ResourceCodec`, to forward the option. It is named `chunkSource` so it does not
collide with `#readChunked`'s `chunks` parameter, which is the sealed count
(section 8, naming).

`codec.decode` forwards `chunkSource` to `#readChunked`. There, when
`chunkSource` is given, the codec builds a local `Transport` subclass. Its
`getChunk({ docId, chunkIndex })` calls `chunkSource({ docId, chunkIndex })` and
throws was-client's `NotFoundError` when the source returns `undefined`, the
name `EdvClientCore` expects (`WasTransport.ts:538-543`). The codec passes it to
`EdvClientCore.getStream` in place of `#transportFor(context)`. The `docId` is
the AEAD-bound id `#readChunked` already uses. The existing
`context === undefined` refusal becomes a refusal when neither is given. Passing
both is refused as ambiguous, under the existing `ValidationError`.

The chunk-binding check is new on the read side. Before a chunk goes to the
decrypt stream, the codec checks that the chunk's protected `was` binding equals
the envelope's. A mismatch throws `EncryptionError`. This needs no wire change,
since the writer already seals the binding into every chunk
(`EdvCodec.ts:733-737`). It covers the network path too.

`blobBytes` (`src/internal/blob.ts:123`) is exported from `./edv/core`.

The option lives in was-client, not here. The package's rule is that reassembly
and its checks belong to the encrypted-collections reference implementation.

### wallet-backup walk

`walkCollection` gains an `openChunked: boolean` input, true only for an
encrypted app collection. With it false, nothing changes: the upfront loop still
counts chunked ids as `ChunkedResourceUnsupportedError`.

With it true:

1. The existing pass skips chunked ids as now, but keeps each one's
   representation bytes (the envelope JSON, a few hundred bytes) in a
   `Map<resourceId, Uint8Array>`. The upfront count loop at
   `collectionWalk.ts:180` goes away for this case. Every other Resource of the
   collection is opened with an empty chunk source, so a chunked envelope with
   no directory counts under `NotFoundError`. Only envelopes that fail that way
   while a chunk directory exists for their id are held. Any other result is
   handled as today.
2. After that pass, if the survey found any chunk directory for this collection,
   one more pass reads only `area: 'chunk'` entries of this collection. It
   groups chunk files by `resourceId` as they arrive. It classifies each file
   with `classifyCollectionFile`, keeps only the `representation` kind, and
   parses its index from the file's `resourceId` with `parseChunkIndexSegment`.
   `.meta.<index>.json` sidecars, names that fail the parse, and a later
   duplicate of an index already held are skipped and not buffered. The bytes go
   in a `Map<number, Uint8Array>`.
3. When the pass moves to a different chunk directory, or ends, the walk
   finishes the group it holds. It removes the envelope from the step 1 map,
   parses it, and opens it through `openResource` with a chunk source. The
   source checks the abort signal, refuses a `docId` other than the group's
   `resourceId`, then parses and deletes the held bytes for that index, or
   returns `undefined` when the index is absent.
4. The decrypt result is routed by type. A `Blob` is read through `blobBytes`,
   and the walk calls `importResource` with `{ bytes, contentType: blob.type }`.
   An empty `blob.type` falls back to `application/octet-stream`. A `Json`
   result goes to `{ json }`, since a chunk directory can sit beside an envelope
   that was later rewritten small (the spec removes chunks only on DELETE,
   `spec.md:1138-1141`).
5. A chunk directory whose envelope is not in the map is a stray, or a later
   fragment of a split directory. It counts unopenable under `NotFoundError`,
   once per directory. A directory whose Resource the first pass already counted
   (an envelope rewritten small, or a pending stub that fails under
   `EncryptionError`) is ignored and its chunks are not buffered, so that
   Resource is counted once. At pass end, every envelope still in the map (its
   directory yielded no chunk file) is opened with an empty source and counted.

Step 3 and the `Blob` read in step 4 run inside the per-Resource open catch, so
a throw there counts the Resource under its cause name. The catch rethrows when
the signal is aborted, and `openResource` does the same, so a cancel during
chunk reads throws the signal's reason (section 2, invariant 10). The
`importResource` call in step 4 keeps its own catch, which counts `failed` and
stops on `QuotaExceededError`, as today. `openResource` passes the chunk source
through to each generation's `decrypt`. The `KeyUnwrapError` fallback to the
next generation works as now, since the envelope is opened before any chunk is
read.

The same result-type routing applies to the first pass. There, a small encrypted
binary or text Resource decrypts to a `Blob` and is handed as `bytes` under
`blob.type`, instead of as `json` under `application/json`. That is WBU-7's fix,
restated here so this design does not depend on it landing first.

### Trust root

A chunked Resource is exactly as authentic as a non-chunked Resource, and the
bundle is the trust root for both. Sealing needs no secret, since every write
seals a fresh key to the write epoch's public key (`docCipher.ts:407-409`).
Whoever built the bundle chooses every sealed value: the count, the content
type, the encoding. The sink receives the sealed content type as an opaque label
and must not interpret it. was-client's write path treats `Uint8Array` data as
binary whatever the type says (`internal/content.ts:189-194`).

### Sink port contract change

`AppCollectionResource`'s type is unchanged. Its documented meaning changes. An
encrypted collection's Resource arrives as `{ json }` when it decrypts to JSON,
and as `{ bytes }` under its sealed content type when it decrypts to a `Blob`.
That covers a chunked Resource and a small binary or text Resource alike. A
chunked Resource whose sealed type is `application/json` still arrives as
`bytes`, which contradicts `sink.ts:12-17` ("A JSON type ... arrives parsed as
`json`"), so that JSDoc is rewritten. A sink that assumed an encrypted Resource
is always JSON now sees bytes. WBU-8 renamed the field from `row` to `json`
(signed off by the user 2026-09-28). This is a change to a contract this package
owns, so it is a walk of the AGENTS.md parties table. freewallet is the one sink
affected today. The CHANGELOG names it as a breaking change to the sink port.

### freewallet sink

The sink needs a route that can store an encrypted chunked Resource, and a rule
that recognizes it on a re-run. Neither exists (section 3). Q1 settled both
(section 8): a bytes Resource in an encrypted collection is written at its
archived `resourceId`, and that id is its identity.

- The write goes through a random-id encrypted handle, with a new was-client
  write-by-id path that accepts a chunk plan (`src/internal/write.ts:297-309`
  refuses one today). A small bytes Resource (WBU-7) takes the same route, so
  both cases share one identity rule. An encrypted JSON Resource keeps its
  content identity (`appRowIdentity`) and its current route.
- A 412 on that id reads the held copy and compares bytes, as the plaintext
  bytes path does. Equal bytes count `skipped`. Different bytes count
  `conflicting`, and the held copy is untouched. Reading a held chunked Resource
  here reassembles one Resource over the network, through the existing context
  path.
- The snapshot of held Resources records a bytes Resource by its id, so it needs
  no reassembly. The snapshot's `Promise.all` over every held document
  (`storageManager.ts:6352`) therefore never holds a reassembled Resource.
- A killed write leaves a `{ pending: true }` stub and its partial chunks at the
  archived id. A later run's 412 read of that id fails under `EncryptionError`.
  The sink recognizes the pending stub, deletes it (chunks included), and
  rewrites the Resource. A stub is reaped only at an id this run is importing,
  so debris is bounded to known ids.
- A second concurrent run could reap a stub the first run is still filling. The
  sink runs one migration at a time.
- A 507 during a chunked write surfaces as `QuotaExceededError`. was-client's
  `#chunkedWriteFailed` rethrows the quota error itself after cleanup, which
  also fixes the misleading "chunks were not written" message after a 507 on the
  final envelope update.

### Versions

The chunk source ships in a new was-client release. wallet-backup's
devDependency and peer range move to it, and the CHANGELOG names that as a
breaking change. A host on an older was-client ignores the option when it
destructures its arguments, and every chunked Resource would count under
`EncryptionError` with no pointer to the version. freewallet bumps was-client
with it. wallet-core's peer range `>=0.78.0` is compatible.

### Wire-level conventions

No new permanent wire artifact. For sign-off:

- The sink port meaning change above, including small binary Resources.
- The rename of the sink payload field from `row` to `json` (WBU-8), signed off
  2026-09-28.
- The re-run identity rule for a bytes Resource in an encrypted collection (Q1).
  It amends decision 0002.
- The report causes a chunked Resource can now carry. All are existing names:
  - `NotFoundError` (was-client) for a missing chunk, a missing chunk directory,
    or a stray directory;
  - `EncryptionError` (was-client) for a pending stub or a chunk-binding
    mismatch, which includes a chunk sealed to another epoch;
  - `DataError` (minimal-cipher) for a corrupted chunk or one moved to another
    index, where the platform decrypt returns null. In Node the same failure
    surfaces as a plain `Error`, since minimal-cipher does not rename Node's
    AEAD throw;
  - `ChunkedResourceUnsupportedError` (kept) for the refused cases.

  Malformed chunk framing can still surface a generic name (`TypeError`, plain
  `Error`, or `SyntaxError` from the chunk source's parse). `KeyMissError` is
  reachable only through a hand-forged chunk header. The walk counts them under
  that name and does not rename them.

- `ValidationError` for a `decrypt` given both `context` and `chunkSource`.
- The `chunkSource` option name on was-client's `decrypt` is a TypeScript API
  name, not a wire artifact. Settled 2026-09-28 (section 8).

## 6. Alternatives rejected

- **Stream the Resource to the sink.** A `ReadableStream` body in
  `AppCollectionResource` would keep invariant 3 as stated, but it buys nothing
  today. was-client's reader already buffers the decrypt stream into a `Blob`
  (`EdvCodec.ts:1010-1020`), was-client's `put` takes no stream, and
  freewallet's re-run comparison reads the held copy whole. It would also change
  the port's shape for every sink, where the chosen design changes only its
  meaning. Revisit when was-client's read and write paths both stream.
- **Reassemble in wallet-backup, or reuse did-cli-typescript's
  `decryptChunks`.** did-cli's function (`src/edv/stream.ts:148`) is a local
  copy of edv-client's `getStream`. It calls `minimal-cipher` directly and skips
  was-client's sealed-count and bound-id checks. Doing the same here would
  duplicate upstream logic and lose those checks. Do-not-reopen.
- **A shim request context instead of a was-client change.** A fake
  `context.request` could serve `.../chunks/<n>` from the archive to a cipher
  built with a `spaceId`. That loads `WasTransport` into the walk's import
  graph, breaking invariant 7, and ties the walk to WAS URL paths.
  Do-not-reopen.
- **Collect chunk files in the survey pass.** The survey would hold every
  chunked Resource's bytes of every collection at once, where the chosen design
  holds one Resource at a time.
- **One archive pass per chunked Resource.** It does not depend on chunk
  directory contiguity, but its cost grows with the number of chunked Resources
  times the archive size. A wallet with hundreds of photos would re-parse a
  large archive hundreds of times.
- **Throw a local error named `NotFoundError` from the walk's chunk source.** It
  would copy an upstream error contract. was-client's local transport raises the
  real one when the source returns `undefined`.

## 7. Test plan

Node suite (`test/node/migrate.test.ts`). Fixtures are built through
was-client's own chunked write: an `EdvCodec` from `./edv/core` built with a
test `transportFactory` (`CodecTransportFactory`, `EdvCodec.ts:167-170`) that
returns an in-memory `WasTransport`-shaped object. The envelopes and chunk files
are then genuine, the private `was` binding is not rebuilt by hand, and the
suite's throwing `fetch` stays installed:

- A chunked Resource in an encrypted app collection migrates. The sink sees
  `bytes` equal to the original plaintext and the sealed content type, and the
  report counts it under the sink's outcome.
- A small encrypted binary Resource arrives as `bytes` under its sealed type.
  Two different small images in one collection both reach the sink.
- A Resource with ten or more chunks, so the file-name order (`r.10` before
  `r.2`) differs from index order.
- Chunk directory before the representation file, and after it. Both migrate.
- A chunk directory with `.meta.<index>.json` sidecars in both orders
  (filesystem and postgres). The sidecars are skipped.
- A missing chunk file counts under `NotFoundError`. A chunk sealed to another
  epoch, and a chunk from another Resource, count under `EncryptionError`. Two
  chunks of one Resource swapped between indexes count under `DataError`, or
  under a plain `Error` in Node. In each case the other Resources migrate.
- A chunked envelope with no chunk directory counts under `NotFoundError`. A
  stray chunk directory counts under `NotFoundError`.
- A pending stub with a partial chunk directory counts under `EncryptionError`.
  So does a pending stub whose chunk directory holds no chunk file, or only
  sidecars.
- A chunk directory beside a non-chunked JSON envelope. The Resource migrates as
  `json`, and the walk does not throw.
- A chunk directory split by another chunk directory of the same collection. The
  first fragment counts under `NotFoundError`, and the second counts once as a
  stray.
- A chunked Resource in a plaintext app collection and in a standard collection
  stays refused under `ChunkedResourceUnsupportedError`.
- An abort between chunked Resources, and one during a Resource's chunk reads,
  throws the signal's reason. The aborted Resource is not counted, and
  `migrateBundle` rejects.

`pnpm run test:dist` (`test/probe/transportClosure.mjs`), with the two new
edv-client entries and the devDependency on the new was-client, stays green.

was-client gains unit tests for the `chunkSource` option: it reassembles, it
keeps the sealed-count and bound-id refusals, it refuses a chunk whose binding
differs from the envelope's, it raises `NotFoundError` for a missing index, and
it refuses `chunkSource` with `context`.

freewallet gains sink tests, shaped by Q1: an encrypted app collection accepts a
`bytes` Resource, a re-run of the same Resource is `skipped`, a 507 mid-chunk
ends the walk under `QuotaExceededError`, and a pending stub from a killed write
is handled on the next run.

A new Playwright spec runs `migrateBundle` in Chromium over a bundle with one
chunked Resource, so the `Blob` path runs in a browser. The existing
`bundle.spec.ts` never runs the walk. React Native is covered only by reading
through `blobBytes` (section 2, invariant 4).

## 8. Open questions

- **Q1. The freewallet write route and the re-run identity for a bytes
  Resource.** Owner: core contributors, before approval. The import cipher uses
  `idDerivation: 'content'`, which cannot chunk. The options:
  - (a) Write at the archived `resourceId` through a random-id encrypted handle,
    with a new was-client write-by-id path for chunked plans. Identity is the
    archived id, as for plaintext bytes Resources. A 412 reads the held copy and
    compares bytes. A killed write leaves a pending stub at that id, so every
    later run gets a 412 and fails to read it. The re-run must detect a pending
    stub and delete and rewrite it.
  - (b) Write through `add()` on a random-id handle, with a fresh id each time.
    Identity is a hash of the plaintext bytes (with or without the content
    type). The snapshot must reassemble every held chunked Resource on every run
    to compute it, one at a time. Pending stubs from killed writes are orphaned
    under random ids, so the snapshot must find and reap them.

  WBU-7 needs the same rule for small binary Resources, so one answer serves
  both. Reviewer lean: (a). It matches the plaintext bytes path, it keeps the
  archived id as the identity decision 0002 already uses there, and it bounds
  torn-state debris to one known id. It costs a was-client write path.

  Settled 2026-09-28: (a). Section 5 ("freewallet sink") states the route.

- **Q2. Chunk directory contiguity.** Owner: core contributors, at review.
  Either the profile spec's entry-order section states it and space-archive's
  ARCHITECTURE.md repeats it, or the walk tolerates a split directory. The
  design assumes the former. Tolerating it costs one archive pass per split
  Resource, and those are rare.

  Settled 2026-09-28: the profile spec states contiguity, and space-archive's
  ARCHITECTURE.md repeats it. The walk refuses a split directory as section 4
  describes.

- **Naming.** The `chunks` option collides with `#readChunked`'s `chunks`
  parameter, which is the sealed count. `chunkSource` is one alternative. Owner:
  core contributors, with the sign-off list. Settled 2026-09-28: `chunkSource`.
- The memory cost of the largest realistic chunked Resource on dcw, and whether
  React Native's `Blob` constructor accepts `Uint8Array` parts at all (section
  2, invariant 4). If it does not, was-client's decrypt of any binary Resource
  fails on dcw. Owner: dcw, when DCW-80 or its successor adds `appCollections`,
  with was-client for the constructor half. Answer lands in that item.

## 9. Review log

Adversarial pass, 2026-09-28. Six lenses ran: consumer completeness, the
interaction matrix, an adversary walk, an invariant audit, torn state, and the
contract's blast radius. Each surviving finding was checked against code. The
findings, most severe first, and where each landed:

- R1. The freewallet sink had no working write route for an encrypted chunked
  Resource. `Resource.put` refuses chunk plans, `add()` refuses them in a
  content-id collection, and the 412/`equalBytes` path the draft cited is the
  plaintext branch. Landed in sections 3 and 5 ("freewallet sink") and as Q1.
- R2. A re-run duplicated every chunked Resource. The snapshot cannot open held
  chunked Resources, and a bytes Resource has no identity under decision 0002.
  Landed in section 2 (decision 0002), section 4 (re-run Resources) and Q1.
- R3. Small encrypted binary Resources already arrive as `row: Blob` under
  `application/json`, and all share one content identity. Silent loss today.
  Landed in sections 1 and 5, and as WBU-7.
- R4. A chunk directory beside a non-chunked envelope crashed the walk without a
  report. Landed in section 5, step 4, and section 4.
- R5. The walk cannot import `NotFoundError` without breaking invariant 7.
  Landed in section 5 (was-client raises it) and section 6.
- R6. `blob.arrayBuffer()` is missing on React Native (invariant 4). Landed in
  section 2 and section 5, step 4.
- R7. A 507 during a chunked write became `EncryptionError`, so quota no longer
  ended the walk. Landed in section 2 (invariant 10) and section 5.
- R8. Chunks are not bound to their envelope on read. Landed in section 2 and
  the was-client subsection (the chunk-binding check).
- R9. The memory count ("at most two copies") was wrong. Landed in section 2.
- R10. The missing-directory case in step 5 could not happen, and a missing
  directory counted under `EncryptionError`. A stray directory dropped out of
  the report. Landed in section 5, steps 1 and 5, and section 4.
- R11. Sidecar files in chunk directories, and duplicate or unparseable chunk
  names. Landed in section 5, step 2.
- R12. A split directory's second fragment was unspecified, and the split test
  used the wrong shape. Landed in section 5, step 3, section 4 and section 7.
- R13. The was-client version pins let an old host mis-report every chunked
  Resource. Landed in section 5 ("Versions").
- R14. The option's placement on shared interfaces (`DocCipher`,
  `ResourceCodec`), with was-react and was-sync behind them. Landed in sections
  3 and 5.
- R15. Unlisted consumers: freewallet's cause map and locale strings, stale
  JSDoc and README text, the probe's edv-client gap, the profile spec and the
  teaching server. Landed in sections 2 and 3, and in the ROADMAP touches list.
- R16. The decrypt stream's error name was several generic names, and the
  other-epoch case is `KeyMissError`, not an authentication failure. Landed in
  section 5 ("Wire-level conventions") and section 4.
- R17. Smaller items: invariant 8's per-chunk content keys, the abort check
  inside the source, the `onProgress` contradiction, the test fixture route and
  the Playwright spec. Landed in sections 2, 4 and 7.

Completeness critic, 2026-09-28, over the revised doc:

- C1. An abort inside the chunk source was caught by `openRow` and counted as an
  unopenable Resource. Landed in sections 2, 4 and 5 (the open catch rethrows on
  abort).
- C2. The per-Resource catch as worded covered `importRow`, which would undo R7.
  Landed in sections 2 and 5.
- C3. The chunk-binding check compares `was.epoch`, so a chunk from another
  epoch fails it under `EncryptionError` and `KeyMissError` is unreachable.
  `DataError` comes from minimal-cipher on a corrupted or moved chunk. Landed in
  sections 3, 4, 5 and 7.
- C4. A held envelope whose chunk directory yields no chunk file dropped out of
  the report. Landed in section 5, step 5, and section 7.
- C5. WBU-7 needs the identity rule Q1 defers. Landed in section 1 and Q1, and
  WBU-7 is blocked by WBU-6's Q1 in the roadmap.
- C6. React Native's `Blob` constructor may refuse `Uint8Array` parts
  (unverified). Landed in section 2 and section 8.
- C7. The envelope map was not bounded by "a few hundred bytes each". Landed in
  section 2 and section 5, step 1 (only envelopes that fail under an empty
  source are held).
- C8. The fixture route skipped `EdvCodec`. Landed in section 7.

Implementation, 2026-09-28. Two places where the code settled what the doc left
loose:

- I1. A chunk moved to another index surfaces as a plain `Error` in Node, not
  `DataError`. minimal-cipher names the failure only where the platform decrypt
  returns null. Landed in sections 3, 4, 5 and 7.
- I2. Step 5 read literally counted a directory whose Resource the first pass
  had already counted as a stray too, which contradicted section 4 and
  section 7. The walk ignores such a directory. Landed in section 2
  (invariant 10) and section 5, step 5.
