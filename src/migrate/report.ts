/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The migration report and the accumulator that builds it. The counts are the
 * host's material for its own activity row, so the shape is fixed here rather
 * than recomputed per wallet: two wallets running the same bundle report the
 * same numbers.
 *
 * The TypeScript shape is not wire. What the host writes into an activity row
 * is the host's contract; this is the in-house interface between the migration
 * and the host.
 */
import type { BundleManifestSummary } from '../bundle/manifest.js'
import type { SinkOutcome } from './sink.js'

/**
 * One collection's counts. `unopenable` Resources never reached the sink: no
 * held user key generation opened them, a chunked Resource could not be
 * reassembled or is not opened where it sits, or the collection was stopped
 * before its first Resource (its `stoppedBy` then names the cause).
 * `unopenableCauses` names why, by error name, with the number of Resources
 * each name accounts for. `stoppedBy` is present only when a run of consecutive
 * failures ended the collection, carrying the last cause's name (or the outcome
 * word `failed` when the sink reported failure without throwing), or when the
 * collection was stopped before its first Resource.
 *
 * Two members carry a descriptor fault the collection migrated in spite of.
 * `generationCauses` names, by error name, the recovered generations dropped
 * before the first Resource because their current-epoch entry failed its
 * key-wrap check, with the number of generations each name accounts for.
 * `indexSchemaCause` names the error that ended the attempt to open the
 * sealed index schema, so the collection was ensured without one. Both are
 * present only when they mean something; an `IntegrityError` in either is a
 * tamper signal on the archived descriptor or metadata, not a missing key.
 */
export interface MigrationCollectionReport {
  accepted: number
  skipped: number
  conflicting: number
  failed: number
  unopenable: number
  stoppedBy?: string
  unopenableCauses?: Record<string, number>
  generationCauses?: Record<string, number>
  indexSchemaCause?: string
}

/**
 * What one migration did. A collection the migration never entered is absent
 * from `collections`, so a present entry means the migration got that far.
 * `stoppedAt` is present only when a quota refusal stopped the whole migration.
 * `notMigrated` counts the Resources of every collection the migration carries
 * no import function for, by collection id, and no sink method saw any of them.
 */
export interface MigrationReport {
  manifest: BundleManifestSummary
  collections: Record<string, MigrationCollectionReport>
  stoppedAt?: { collectionId: string; cause: string }
  notMigrated: Record<string, number>
}

/**
 * Adds one to the count held under `key`, starting it at one.
 */
function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/**
 * Turns a tally keyed by a name the bundle chose into the record the report
 * carries. The keys come out of an archive, so a plain object literal would
 * silently lose a collection named `__proto__`: the assignment reaches the
 * prototype setter rather than creating a property, and that collection's
 * Resources would go uncounted. Accumulating in a `Map` and converting here
 * keeps every name countable, and the null prototype keeps the result safe for
 * a consumer that indexes it by a name it did not choose either.
 *
 * @param counts {Map<string, TValue>}
 * @returns {Record<string, TValue>}
 */
export function keyedRecord<TValue>(
  counts: Map<string, TValue>
): Record<string, TValue> {
  const record = Object.create(null) as Record<string, TValue>
  for (const [key, value] of counts) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return record
}

/**
 * The per-collection tally the migration fills in as it goes.
 */
export class CollectionTally {
  accepted = 0
  skipped = 0
  conflicting = 0
  failed = 0
  unopenable = 0
  stoppedBy?: string
  indexSchemaCause?: string
  readonly #unopenableCauses = new Map<string, number>()
  readonly #generationCauses = new Map<string, number>()

  /**
   * Records one sink outcome.
   * @param outcome {SinkOutcome}
   * @returns {void}
   */
  countOutcome(outcome: SinkOutcome): void {
    this[outcome] += 1
  }

  /**
   * Records one Resource no key opened, under the error name that explains it.
   * @param cause {string}   the error name
   * @returns {void}
   */
  countUnopenable(cause: string): void {
    this.unopenable += 1
    increment(this.#unopenableCauses, cause)
  }

  /**
   * Records one recovered generation dropped at cipher construction, under
   * the error name that explains it.
   * @param cause {string}   the error name
   * @returns {void}
   */
  countDroppedGeneration(cause: string): void {
    increment(this.#generationCauses, cause)
  }

  /**
   * The tally as the report carries it, with the optional members present only
   * where they mean something.
   * @returns {MigrationCollectionReport}
   */
  toReport(): MigrationCollectionReport {
    const report: MigrationCollectionReport = {
      accepted: this.accepted,
      skipped: this.skipped,
      conflicting: this.conflicting,
      failed: this.failed,
      unopenable: this.unopenable
    }
    if (this.stoppedBy !== undefined) {
      report.stoppedBy = this.stoppedBy
    }
    if (this.#unopenableCauses.size > 0) {
      report.unopenableCauses = keyedRecord(this.#unopenableCauses)
    }
    if (this.#generationCauses.size > 0) {
      report.generationCauses = keyedRecord(this.#generationCauses)
    }
    if (this.indexSchemaCause !== undefined) {
      report.indexSchemaCause = this.indexSchemaCause
    }
    return report
  }
}
