/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One migrated collection's pass: read a row's envelope, open it with the
 * newest generation that can, hand the plaintext to the sink, and tally what
 * happened. The pass holds one row at a time -- it awaits the sink before it
 * reads the next entry -- and issues no request of its own, since the ciphers
 * it was handed carry no transport.
 *
 * Two rules end something early. A run of consecutive failures ends this
 * collection (an outage, not a row that will never land), and the walk moves
 * on. A sink throw named for the server's quota refusal ends the whole walk,
 * which this pass reports back to its caller rather than deciding.
 */
import {
  classifyCollectionFile,
  parseArchivePath,
  readSpaceArchive
} from '@interop/space-archive'
import { ChunkedResourceUnsupportedError } from '../errors.js'
import type { ByteSource } from '@interop/space-archive'
import type { CollectionTally } from './report.js'
import { MAX_CONSECUTIVE_FAILURES, WALK_STOPPING_ERROR_NAME } from './sink.js'
import type { MigrationSink, MigrationSinkMethod, SinkOutcome } from './sink.js'

/**
 * A decrypting cipher for one generation, as `ciphersForCollection` builds it.
 */
type RowCipher = {
  decrypt: (options: { id: string; envelope: never }) => Promise<unknown>
}

/**
 * What one row's open produced: the plaintext, or the error name that explains
 * why no held generation opened it.
 */
type OpenedRow = { row: unknown } | { cause: string }

/**
 * Opens one envelope, newest generation first. A `KeyUnwrapError` is the
 * fallback signal -- this generation holds no key for that row's epoch -- and
 * the next generation is tried. Anything else is this row's answer: an
 * `UnknownEpochError` means the descriptor lists no such epoch, which no other
 * generation can change.
 *
 * @param options {object}
 * @param options.ciphers {RowCipher[]}   newest generation first
 * @param options.resourceId {string}   the id the envelope is bound to
 * @param options.envelope {unknown}
 * @returns {Promise<OpenedRow>}
 */
async function openRow({
  ciphers,
  resourceId,
  envelope
}: {
  ciphers: RowCipher[]
  resourceId: string
  envelope: unknown
}): Promise<OpenedRow> {
  let lastCause = 'KeyUnwrapError'
  for (const cipher of ciphers) {
    try {
      return {
        row: await cipher.decrypt({
          id: resourceId,
          envelope: envelope as never
        })
      }
    } catch (err) {
      const name = (err as Error).name
      if (name !== 'KeyUnwrapError') {
        return { cause: name }
      }
      lastCause = name
    }
  }
  return { cause: lastCause }
}

/**
 * Walks one migrated collection's rows.
 *
 * @param options {object}
 * @param options.archive {ByteSource}   the account Space archive's bytes
 * @param options.collectionId {string}
 * @param options.method {MigrationSinkMethod}   the sink method this
 *   collection's rows go to
 * @param options.sink {MigrationSink}
 * @param options.ciphers {RowCipher[]}   one per generation, newest first
 * @param options.chunked {ReadonlySet<string>}   the collection's chunk-stored
 *   Resource ids, which this walk does not open
 * @param options.tally {CollectionTally}   filled in as the pass goes
 * @param [options.signal] {AbortSignal}   checked between rows
 * @param [options.onProgress] {function}
 * @returns {Promise<{ stopped?: string }>}   the cause name when a quota
 *   refusal ended the whole walk
 */
export async function walkCollection({
  archive,
  collectionId,
  method,
  sink,
  ciphers,
  chunked,
  tally,
  signal,
  onProgress
}: {
  archive: ByteSource
  collectionId: string
  method: MigrationSinkMethod
  sink: MigrationSink
  ciphers: RowCipher[]
  chunked: ReadonlySet<string>
  tally: CollectionTally
  signal?: AbortSignal
  onProgress?: (options: {
    collectionId: string
    index: number
    outcome: SinkOutcome | 'unopenable'
  }) => void
}): Promise<{ stopped?: string }> {
  let index = 0
  let consecutiveFailures = 0

  /**
   * Records one row's outcome and reports it to the caller's progress hook.
   * @param outcome {SinkOutcome | 'unopenable'}
   * @returns {void}
   */
  function progress(outcome: SinkOutcome | 'unopenable'): void {
    onProgress?.({ collectionId, index, outcome })
    index += 1
  }

  for (let count = 0; count < chunked.size; count += 1) {
    tally.countUnopenable(ChunkedResourceUnsupportedError.name)
    progress('unopenable')
  }

  const opened = await readSpaceArchive(archive)
  for await (const entry of opened.entries) {
    if (signal?.aborted) {
      throw signal.reason
    }
    const position = parseArchivePath(entry.name)
    if (
      position.area !== 'collection' ||
      position.collectionId !== collectionId ||
      entry.type !== 'file'
    ) {
      continue
    }
    const file = classifyCollectionFile(position.fileName)
    if (file.kind !== 'representation' || chunked.has(file.resourceId)) {
      continue
    }
    const { resourceId } = file

    let envelope: unknown
    try {
      envelope = JSON.parse(new TextDecoder().decode(await entry.bytes()))
    } catch (err) {
      tally.countUnopenable((err as Error).name)
      progress('unopenable')
      continue
    }
    const result = await openRow({ ciphers, resourceId, envelope })
    if ('cause' in result) {
      tally.countUnopenable(result.cause)
      progress('unopenable')
      continue
    }

    let outcome: SinkOutcome
    try {
      outcome = await sink[method]({
        collectionId,
        resourceId,
        row: result.row
      })
    } catch (err) {
      const cause = (err as Error).name
      tally.countOutcome('failed')
      progress('failed')
      if (cause === WALK_STOPPING_ERROR_NAME) {
        return { stopped: cause }
      }
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        tally.stoppedBy = cause
        return {}
      }
      continue
    }
    tally.countOutcome(outcome)
    progress(outcome)
    if (outcome === 'failed') {
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // The sink reported the failure rather than throwing one, so there is
        // no cause name to carry; the outcome word is what is known.
        tally.stoppedBy = 'failed'
        return {}
      }
      continue
    }
    consecutiveFailures = 0
  }
  return {}
}
