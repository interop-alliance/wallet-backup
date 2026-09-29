/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One migrated collection's pass: read a Resource's envelope, open it with the
 * newest generation that can, hand the plaintext to the sink, and tally what
 * happened. A plaintext collection's Resources need no opening: a JSON body is
 * handed on parsed, and any other content type as its archived bytes. The pass
 * holds one Resource at a time -- it awaits the sink before it reads the next
 * entry -- and issues no request of its own, since the ciphers it was handed
 * carry no transport.
 *
 * Two rules end something early. A run of consecutive failures ends this
 * collection (an outage, not a Resource that will never land), and the walk
 * moves on. A sink throw named for the server's quota refusal ends the whole
 * walk, which this pass reports back to its caller rather than deciding.
 */
import {
  classifyCollectionFile,
  parseArchivePath,
  readSpaceArchive
} from '@interop/space-archive'
import { isJsonContentType } from '@interop/storage-core'
import { ChunkedResourceUnsupportedError } from '../errors.js'
import type { ByteSource } from '@interop/space-archive'
import type { CollectionTally } from './report.js'
import { MAX_CONSECUTIVE_FAILURES, WALK_STOPPING_ERROR_NAME } from './sink.js'
import type { AppCollectionResource, SinkOutcome } from './sink.js'

/**
 * A decrypting cipher for one generation, as `ciphersForCollection` builds it.
 */
type ResourceCipher = {
  decrypt: (options: { id: string; envelope: never }) => Promise<unknown>
}

/**
 * What one Resource's open produced: the plaintext, or the error name that
 * explains why no held generation opened it.
 */
type OpenedResource = { json: unknown } | { cause: string }

/**
 * Opens one envelope, newest generation first. A `KeyUnwrapError` is the
 * fallback signal -- this generation holds no key for that Resource's epoch --
 * and the next generation is tried. Anything else is this Resource's answer: an
 * `UnknownEpochError` means the descriptor lists no such epoch, which no other
 * generation can change.
 *
 * @param options {object}
 * @param options.ciphers {ResourceCipher[]}   newest generation first
 * @param options.resourceId {string}   the id the envelope is bound to
 * @param options.envelope {unknown}
 * @returns {Promise<OpenedResource>}
 */
async function openResource({
  ciphers,
  resourceId,
  envelope
}: {
  ciphers: ResourceCipher[]
  resourceId: string
  envelope: unknown
}): Promise<OpenedResource> {
  let lastCause = 'KeyUnwrapError'
  for (const cipher of ciphers) {
    try {
      return {
        json: await cipher.decrypt({
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
 * Turns one archived representation into the body the sink is handed. A
 * plaintext collection's body is handed on as its bytes when its content type
 * is not JSON, and parsed when it is. An encrypted collection's body is parsed
 * and then opened. A body that does not parse is answered with the parse
 * error's name.
 *
 * @param options {object}
 * @param options.ciphers {ResourceCipher[] | undefined}   newest generation
 *   first; `undefined` for a plaintext collection
 * @param options.resourceId {string}
 * @param options.contentType {string}   the archived representation's type
 * @param options.bytes {Uint8Array}   the archived representation's body
 * @returns {Promise<OpenedResource | { bytes: Uint8Array }>}
 */
async function readResource({
  ciphers,
  resourceId,
  contentType,
  bytes
}: {
  ciphers: ResourceCipher[] | undefined
  resourceId: string
  contentType: string
  bytes: Uint8Array
}): Promise<OpenedResource | { bytes: Uint8Array }> {
  if (ciphers === undefined && !isJsonContentType(contentType)) {
    return { bytes }
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    return { cause: (err as Error).name }
  }
  if (ciphers === undefined) {
    return { json: body }
  }
  return openResource({ ciphers, resourceId, envelope: body })
}

/**
 * Walks one migrated collection's Resources.
 *
 * @param options {object}
 * @param options.archive {ByteSource}   the account Space archive's bytes
 * @param options.collectionId {string}
 * @param options.importResource {function}   the sink function this
 *   collection's Resources go to
 * @param options.ciphers {ResourceCipher[] | undefined}   one per generation,
 *   newest first; `undefined` for a plaintext collection
 * @param options.chunked {ReadonlySet<string>}   the collection's chunk-stored
 *   Resource ids, which this walk does not open
 * @param options.tally {CollectionTally}   filled in as the pass goes
 * @param [options.signal] {AbortSignal}   checked between Resources
 * @param [options.onProgress] {function}
 * @returns {Promise<{ stopped?: string }>}   the cause name when a quota
 *   refusal ended the whole walk
 */
export async function walkCollection({
  archive,
  collectionId,
  importResource,
  ciphers,
  chunked,
  tally,
  signal,
  onProgress
}: {
  archive: ByteSource
  collectionId: string
  importResource: (options: AppCollectionResource) => Promise<SinkOutcome>
  ciphers: ResourceCipher[] | undefined
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
   * Records one Resource's outcome and reports it to the caller's progress
   * hook.
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
    const { resourceId, contentType } = file
    const handed = await readResource({
      ciphers,
      resourceId,
      contentType,
      bytes: await entry.bytes()
    })
    if ('cause' in handed) {
      tally.countUnopenable(handed.cause)
      progress('unopenable')
      continue
    }

    let outcome: SinkOutcome
    try {
      outcome = await importResource({
        collectionId,
        resourceId,
        // A decrypted Resource is JSON; the archived type names the envelope's.
        contentType: ciphers === undefined ? contentType : 'application/json',
        ...handed
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
