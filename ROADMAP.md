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
