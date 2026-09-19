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
 * is the host's contract; this is the in-house interface between the walk and
 * the host.
 */
import type { BundleManifestSummary } from '../bundle/manifest.js'
import type { SinkOutcome } from './sink.js'

/**
 * One collection's counts. `unopenable` rows never reached the sink: no held
 * user key generation opened them, or the Resource is chunked.
 * `unopenableCauses` names why, by error name, with the number of rows each
 * name accounts for. `stoppedBy` is present only when a run of consecutive
 * failures ended the collection, carrying the last cause's name (or the
 * outcome word `failed` when the sink reported failure without throwing).
 */
export interface MigrationCollectionReport {
  accepted: number
  skipped: number
  conflicting: number
  failed: number
  unopenable: number
  stoppedBy?: string
  unopenableCauses?: Record<string, number>
}

/**
 * What one walk did. A collection the walk never entered is absent from
 * `collections`, so a present entry means the walk got that far. `stoppedAt`
 * is present only when a quota refusal stopped the whole walk.
 * `notMigrated` counts the rows of every collection the walk carries no import
 * function for, by collection id, and no sink method saw any of them.
 */
export interface MigrationReport {
  manifest: BundleManifestSummary
  collections: Record<string, MigrationCollectionReport>
  stoppedAt?: { collectionId: string; cause: string }
  notMigrated: Record<string, number>
}

/**
 * Turns a tally keyed by a name the bundle chose into the record the report
 * carries. The keys come out of an archive, so a plain object literal would
 * silently lose a collection named `__proto__`: the assignment reaches the
 * prototype setter rather than creating a property, and that collection's rows
 * would go uncounted. Accumulating in a `Map` and converting here keeps every
 * name countable, and the null prototype keeps the result safe for a consumer
 * that indexes it by a name it did not choose either.
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
 * The per-collection tally the walk fills in as it goes.
 */
export class CollectionTally {
  accepted = 0
  skipped = 0
  conflicting = 0
  failed = 0
  unopenable = 0
  stoppedBy?: string
  readonly #unopenableCauses = new Map<string, number>()

  /**
   * Records one sink outcome.
   * @param outcome {SinkOutcome}
   * @returns {void}
   */
  countOutcome(outcome: SinkOutcome): void {
    this[outcome] += 1
  }

  /**
   * Records one row no key opened, under the error name that explains it.
   * @param cause {string}   the error name
   * @returns {void}
   */
  countUnopenable(cause: string): void {
    this.unopenable += 1
    this.#unopenableCauses.set(
      cause,
      (this.#unopenableCauses.get(cause) ?? 0) + 1
    )
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
    return report
  }
}
