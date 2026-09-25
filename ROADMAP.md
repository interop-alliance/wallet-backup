# Wallet-Backup (open items)

nextAvailableId: 6

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

### WBU-5: Stream `writeBundle` instead of buffering the whole bundle

- status: todo
- priority: medium
- labels: export, streaming

Context: `writeBundle` collects every Space archive with `collectBytes`, writes
each as a tar entry, and calls `pack.finalize()` before returning, with no
consumer attached. Nothing reads the pack while it is written, so the finished
bundle sits in the pack's own queue in memory, and a host that pipes it to a
file sees the file appear only once the whole export has finished. A backup of
an account with several large Spaces is therefore bounded by memory rather than
by disk, and the user gets no progress from the save itself.
`discovered-from: freewallet FW-530`.

The writer should hand the pack (or a stream over it) back before the entries
are written, and write each entry as the consumer drains: await the pack's drain
signal between entries so backpressure reaches the per-Space export, and report
a failure part way through by destroying the pack (`pack.destroy(err)`) so the
consumer sees the error rather than a truncated tar. A Space archive still has
to be collected before its own entry is written, since a tar header carries the
entry size, so the bound drops from the whole bundle to one archive.

The host halves matter for the acceptance: freewallet's save picker opens before
the run today precisely because the bundle is buffered, and a streaming writer
lets the picked file fill as the export proceeds.

- acceptance:
  - [ ] `writeBundle` returns before its entries are written, and writes them as
        the consumer drains
  - [ ] Backpressure reaches the per-Space export: an undrained consumer stops
        the next Space from being exported
  - [ ] A per-Space failure destroys the pack, and the consumer sees that error
  - [ ] The bundle's bytes are unchanged (the byte-reproducibility test still
        passes)
  - [ ] The three host-facing comments corrected for FW-530 (`exportBundle.ts`,
        `writeBundle.ts`, freewallet's `backupExport.ts` and `saveStream.ts`)
        are updated to the streaming behavior
  - [ ] `exportBundle` hands back a `ReadableStream<Uint8Array>` (or the package
        exports the AsyncIterable-to-ReadableStream adapter), so a host neither
        casts the pack's `unknown` chunks nor writes the adapter itself
        (freewallet's `streamFromPack` is the copy to delete)
  - [ ] The writer bounds how many Space exports are in flight (a small fixed
        number ahead of the entry being written) rather than one at a time, so
        an account with many recovery codes is not strictly serial; the bound,
        not the host, decides, since the host's per-Space callback cannot see
        the consumer's backpressure
