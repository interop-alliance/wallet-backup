# 0001: The migration walk lives here, behind a push sink port

- Status: accepted
- Date: 2026-09-17
- Driving work: the design for migrating a backup bundle's content into
  a new wallet account, on any server, from the bundle file and one old
  secret alone.
- Affects: `@interop/wallet-backup` (the bundle reader, the per-Space
  archive codec, the secret-to-user-key derivation, the decrypt walk,
  the sink port, the report); freewallet and dcw (each implements the
  sink over its own stores); was-teaching-server (both backends write
  the per-Space archive through this package's writer).

## Context

A bundle is tar-in-tar: an outer archive with a FEP-6fcd `manifest.yml`
and one per-Space export archive per Space, verbatim server bytes. The
migration reads the account Space archive, derives the old user key
from an old secret through the archived user-key roster, decrypts each
standard collection's envelopes, and writes plaintext rows into the new
account. Two wallets share the ceremonies (`@interop/wallet-core`) and
both need this. The rows can number in the thousands, the Argon2id
derivation holds a 64MiB working set, and every existing tar reader in
the wallets buffers the whole file, so memory shapes the API.

The per-Space archive layout was, at the time, the teaching server's
private file-name codec with no spec text, re-derived separately by its
Postgres backend, and parsed by no client.

## Decision

`@interop/wallet-backup` owns the whole read side: the outer tar codec,
the manifest parse and archive-role vocabulary, the per-Space archive
reader and writer with the file-name codec, the packed-code reading and
unsealing, the derivation, the decrypt walk, and the report. It issues
no HTTP request and holds no collection in memory.

The walk drives the loop (push). The host passes a sink with one method
per migrated collection; each method takes one plaintext row and
returns `accepted`, `skipped`, `conflicting`, or `failed`. The walk
awaits each call before decrypting the next row, takes an `AbortSignal`
for cancel and an `onProgress` callback, and computes the report. The
package knows no wallet row types; the sink is the only wallet-specific
code.

The per-Space archive codec has one implementation, this package's
reader and writer. The server's backends write through the writer. The
layout is profile text in the portable wallet profile spec, and this
package's AGENTS.md carries the parties table with a counterpart test on
each side.

## Rejected Alternatives

- The walk in `@interop/wallet-core`. It would pull tar and manifest
  parsing into the ceremony package, which has no I/O of its own, and
  the primitives the walk composes are already exported from
  wallet-core's subpaths.
- A tar-only package with each wallet running its own decrypt loop. Two
  copies of the derivation and epoch fallback, against the
  no-reimplementation rule.
- A pull shape (an async iterable the host consumes). Backpressure and
  cancel come for free, but each wallet then computes its own report,
  and the report feeds a stored activity row whose counts must agree
  across wallets.
- The archive codec as spec text alone, or as a server AGENTS.md
  contract with a counterpart test, or as a `@interop/was-client`
  subpath. The first pins nothing until a second server exists, the
  second pins by test and not by text, and the third moves a
  server-side concern into a client library.

## Consequences

- The server depends on this package for its export writer. A codec
  change is a coordinated release across the server, this package, and
  the profile spec.
- A sink method that throws a quota-named error stops the walk; ten
  consecutive failures end the current collection. Both are the walk's
  rules, not the sink's.
- dcw implements a second sink and gets the same report shape.

## Revisit Criteria

1. A second server implementation exports a per-Space archive in a
   layout this codec cannot read; the profile text then governs and the
   codec follows it.
2. The walk needs to write to the server directly (for instance a
   restore that bypasses the wallet's own stores); the no-HTTP rule
   would then need a stated exception rather than a quiet one.

## Amendment (2026-09-18)

The per-Space archive codec's one implementation now lives in
`@interop/space-archive`, not in this package. This package consumes it
for the bundle codec and for the migration walk; the WAS reference
server consumes it for export. This package stays the migration walk's
home: the decision above still holds for the outer tar codec, the
manifest parse and archive-role vocabulary, the packed-code reading and
unsealing, the derivation, the decrypt walk, and the report. Only the
per-Space archive reader and writer moved, because the server needed
only the codec and was installing the walk's whole dependency set
(`@interop/wallet-core`, `@interop/was-client`, `@interop/social-core`,
`@interop/vh-resource-log`, Argon2) through this package to get it.
