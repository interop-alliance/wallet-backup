# Wallet-Backup (open items)

nextAvailableId: 12

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

### WBU-10: A failed lazy epoch unwrap is repeated for every Resource under that epoch

- status: todo
- priority: low
- labels: migrate, encryption, performance
- touches:
  - was-client: the EDV codec's lazy read-epoch unwrap, so a failed unwrap of
    one epoch is remembered on the cipher and later decrypts under that epoch
    fail at once; its ARCHITECTURE/AGENTS files if they describe the unwrap.
  - wallet-backup: nothing to change once was-client remembers the failure; bump
    the was-client peer range to the version that does, and note it in
    CHANGELOG.
- acceptance:
  - [ ] was-client caches a lazy epoch unwrap that raised `IntegrityError`, so
        the second decrypt under that epoch raises it without a second unwrap.
  - [ ] The migration test for a corrupt older-epoch entry runs over several
        Resources under that epoch and a was-client-side spy sees one unwrap.

Context: the newest generation's cipher unwraps its older-epoch entries lazily,
on the first Resource sealed under that epoch. If that entry fails its AES-KW
check the migration records `IntegrityError` as the Resource's cause and
correctly tries no older generation, but was-client does not remember that the
unwrap failed. Every further Resource under the same epoch repeats the same ECDH
and AES-KW attempt before being counted. The result is correct; the cost is one
futile unwrap per Resource under a damaged epoch. The cipher owns the epoch
bookkeeping, so the memo belongs there rather than in this package, which
deliberately does not read the epoch id out of an envelope.

discovered-from: WBU-9 (code review of its change set, 2026-10-27).

### WBU-11: Settle the term "walk" in the glossary and the prose that uses it

- status: todo
- priority: low
- labels: docs, glossary
- touches:
  - wallet-backup: ARCHITECTURE.md (the Glossary, the layer map, invariants 6,
    7, 8 and 10, the ownership heuristics), README.md's migration section, the
    module headers and JSDoc under `src/migrate/` and
    `src/bundle/readBundle.ts`, the identifier `walkCollection` and the file
    name `collectionWalk.ts` if the settled term retires them, AGENTS.md's
    parties table if its wording changes.
    `decisions/0001-the-walk-lives-here-behind-a-push-sink.md` keeps its file
    name and title; a record is not rewritten.
- acceptance:
  - [ ] The Glossary names one canonical term for one run of `migrateBundle`
        (the existing "Migration" entry, or a replacement) and lists "walk"
        under its `Avoid:` synonyms, or defines "walk" for exactly one of its
        two current senses with the other given its own term.
  - [ ] The tar entry iteration the readers expose has its own glossary term,
        distinct from the migration run.
  - [ ] ARCHITECTURE.md, README.md and the `src/` prose use the settled terms
        throughout; a grep for "walk" finds only the senses the glossary allows.
  - [ ] Code identifiers that carry the retired sense are renamed in the same
        change set, with a CHANGELOG entry if any is exported.

Context: "walk" is used throughout ARCHITECTURE.md, README.md and the migration
source for two different things. One is the whole migration run: "the walk
refuses early or counts", "the walk issues no request", "what a finished walk
hands back". The other is the lazy tar entry iteration the bundle and archive
readers expose: "walk lazily", "the walks are one-shot", "the tar-walk helpers".
The Glossary defines "Migration" for the first sense and nothing for the second,
and never mentions "walk" at all, so the term is neither canonical nor banned,
and a reader cannot tell from the word which of the two is meant. The ambiguity
was called out in the review of the WBU-9 change set; its new prose says
"migration" and the rest of the repo was left as it was.

discovered-from: WBU-9 (2026-10-27).
