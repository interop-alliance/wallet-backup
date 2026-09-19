# 0002: The merge rule is skip-existing by content identity, per collection

- Status: accepted
- Date: 2026-09-17
- Driving work: the design for migrating a backup bundle's content into
  a new wallet account, which must converge on a re-run and leave a
  populated target account's own rows intact.
- Affects: `@interop/wallet-backup` (the sink port's outcome vocabulary
  and the report); freewallet and dcw (each sink's existence check per
  collection).

## Context

A re-run of the same bundle must land nothing twice, and a bundle
imported into an account that already holds content must not overwrite
it. The stored row id is an envelope hash and JWE encryption is
nondeterministic, so the row id identifies nothing across runs. Each
collection has its own natural identity: a credential's cid, a
contact's `contactId`, a contact revision's payload, an activity's inner
id. Two of those, `contactId` and the activity id, are not content
identities: the body under a given id is free, and both are bundle
text.

## Decision

Each import function skips a row the account already holds, by content
identity, and counts it. The identities are:

- credentials: the cid;
- contacts: the `contactId`, and then `contentCid` of the archived
  head's payload against the held head's;
- contact revisions: `contentCid` of the plaintext payload;
- activity rows: the inner `id`, and then `contentCid` of the body.

A held id whose body differs from the archived row's is `conflicting`:
the archived row lands nowhere, the held row is untouched, and the
report names it. `contentCid` is the existing function from
`@interop/was-client/sync` (base64url-nopad SHA-256 over the JCS form);
nothing is stored, and no row changes shape.

An archived `created` activity is dropped only when the account already
holds a `created` activity for its cid. A revision whose head the run
counted `failed` or `conflicting`, or whose head neither the bundle nor
the account holds, is counted as not migrated.

## Rejected Alternatives

- Skip by id alone for contacts and activity. A doctored bundle reusing
  the genuine bundle's ids under substituted bodies would then pre-empt
  the genuine rows for good, since a later import of the genuine bundle
  reports them skipped.
- The tuple `(contactId, timestamp, writerId, action)` as a revision's
  identity. It ignores the snapshot and adds a second identity rule
  beside the cid.
- Dropping an archived `created` activity whenever its cid was skipped
  as existing. A first run killed before `wallet-activity` leaves every
  cid existing, so every re-run drops every archived `created` row.
- Last-write-wins on the archived `updatedAt`. It would overwrite a
  populated account's newer rows with the bundle's older ones.

## Consequences

- The existence checks cost a decrypt scan per contact and per activity
  collection today. A stored blinded content-identity index would make
  them direct; the value would be the same one computed here.
- On a remembered session the checks read the local replica, which can
  lag the remote; the walk awaits each synced collection's in-sync
  state before its first read.
- Convergence: landed rows are skipped, failed rows are retried,
  conflicting rows stay conflicting until the user resolves them by
  hand.

## Revisit Criteria

1. A stored content-identity index lands on the encrypted collections;
   the scan is then replaced, and the identity values must stay the
   ones listed here.
2. A collection is added whose rows carry no natural identity and no
   stable payload; a fifth rule is then needed rather than a stretch of
   one above.
