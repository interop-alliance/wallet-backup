# 0003: Chunked Resources are reassembled by was-client, from a caller-supplied chunk source

- Status: accepted
- Date: 2026-09-28
- Driving work: the design for migrating chunked Resources in encrypted app
  collections out of a backup bundle, offline.
- Affects: `@interop/wallet-backup` (`src/migrate/collectionWalk.ts`, invariant
  7); `@interop/was-client` (`EdvDocCipher.decrypt` and `EdvCodec`'s chunked
  read).

## Context

A chunked Resource in an encrypted collection is an envelope that seals a chunk
count, plus chunk Resources that each carry their own JWE. In a backup bundle
the chunks are files in the per-Space archive. The migration walk must
reassemble them without issuing a request and without evaluating a transport
module (invariant 7).

was-client already reassembles chunked envelopes over WAS routes. Its reader
checks that the chunk count is the sealed one and that chunks are addressed by
the envelope's AEAD-bound id. The reader needed a request context to reach the
chunks.

## Decision

Reassembly and its checks stay in was-client. `EdvDocCipher.decrypt` takes a
`chunkSource` option in place of a request context, a function that returns one
chunk per `{ docId, chunkIndex }`. was-client wraps it in a local `Transport`
and runs its existing reader over it. The walk supplies the source from the
archive's chunk files and does nothing else with the chunk bytes.

## Rejected Alternatives

- Reassemble in wallet-backup, or reuse did-cli-typescript's `decryptChunks`.
  That function is a local copy of edv-client's `getStream` that calls
  minimal-cipher directly. It skips the sealed-count and bound-id checks and
  reads its own directory layout. Either route duplicates upstream logic and
  loses the checks.
- A shim request context that serves `.../chunks/<n>` from the archive to a
  cipher built with a `spaceId`. It loads `WasTransport` into the walk's import
  graph, which breaks invariant 7, and ties the walk to WAS URL paths.

## Consequences

- Every reader of a chunked envelope shares one set of checks, and a new check
  (such as the read-side chunk-binding check) reaches the archive path and the
  network path together.
- wallet-backup's was-client peer range follows the release that carries
  `chunkSource`.
- The walk's import graph reaches one transport, an in-memory one over bytes
  already read from the archive.

## Revisit Criteria

1. The encrypted-collections spec defines a second chunk framing that was-client
   does not implement.
2. was-client's reader and write paths both stream. The chunk source may then
   become a stream rather than a per-index function, as a change in was-client.
