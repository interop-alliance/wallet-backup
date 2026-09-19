# Wallet-Backup (open items)

nextAvailableId: 4

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

### WBU-2: Register wallet-backup as a party to the encrypted-collections contract

- status: todo
- priority: medium
- labels: docs, cross-repo
- touches:
  - encrypted-collections-spec -- AGENTS.md "Parties to this contract" table
    gains a wallet-backup row
  - wallet-backup -- ARCHITECTURE.md "What lives elsewhere" names the
    encrypted-collections contract and the modules here that read it
- acceptance:
  - [ ] The spec's parties table lists wallet-backup with `src/migrate/` (the
        descriptor read in `descriptorLog.ts`, the row open in `generations.ts`)
        and `src/bundle/recoveryCode.ts` (the one-epoch record descriptor)
  - [ ] ARCHITECTURE.md here states the same relationship

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

- status: draft
- priority: low
- labels: packaging, cross-repo

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
- wallet-core WC-246: leaf entries for the pure derivations, with an
  import-graph test. It excludes the recovery client until WC-245 lands.

Promote to `todo` when WC-246 is published. Acceptance at that point is an
import-graph test here, in the manner of was-client's
`test/node/import-graph.test.ts`, asserting that `src/` evaluates no transport
module. The recovery code path is exempt until WC-245 lands.
