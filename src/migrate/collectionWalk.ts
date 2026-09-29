/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One migrated collection's pass: read a Resource's envelope, open it with the
 * newest generation that can, hand the plaintext to the sink, and tally what
 * happened. A plaintext collection's Resources need no opening: a JSON body is
 * handed on parsed, and any other content type as its archived bytes. An
 * encrypted Resource is handed on by what it decrypts to: JSON as `json`, and a
 * `Blob` as its `bytes` under the sealed content type. The pass holds one
 * Resource at a time -- it awaits the sink before it reads the next entry --
 * and issues no request of its own, since the ciphers it was handed carry no
 * transport.
 *
 * A chunked Resource in an encrypted app collection is reassembled by
 * was-client from the archive's chunk files. The first pass holds the few
 * hundred bytes of each chunked envelope. A second pass reads only this
 * collection's chunk directories, one at a time, and opens each envelope with
 * a chunk source over the chunk files of its directory. That relies on the
 * archive packing a chunk directory's files together. A reassembled Resource is
 * handed over whole, so the per-Resource bound is the largest such Resource.
 * Anywhere else a chunked Resource is refused and counted.
 *
 * Two rules end something early. A run of consecutive failures ends this
 * collection (an outage, not a Resource that will never land), and the walk
 * moves on. A sink throw named for the server's quota refusal ends the whole
 * walk, which this pass reports back to its caller rather than deciding.
 */
import {
  classifyCollectionFile,
  parseArchivePath,
  parseChunkIndexSegment,
  readSpaceArchive
} from '@interop/space-archive'
import { isJsonContentType } from '@interop/storage-core'
import { blobBytes } from '@interop/was-client/edv/core'
import type { ChunkSource } from '@interop/was-client/edv/core'
import { ChunkedResourceUnsupportedError } from '../errors.js'
import type { ByteSource } from '@interop/space-archive'
import type { CollectionTally } from './report.js'
import { MAX_CONSECUTIVE_FAILURES, WALK_STOPPING_ERROR_NAME } from './sink.js'
import type { AppCollectionResource, SinkOutcome } from './sink.js'

/**
 * The name of the error was-client raises when a chunk source holds no chunk
 * at an index the envelope's sealed count asks for. The walk counts a stray
 * chunk directory under the same name. Matched by name, since the error is
 * minted in was-client and its class is not reachable from the offline entry.
 */
const MISSING_CHUNK_ERROR_NAME = 'NotFoundError'

/**
 * The content type a decrypted `Blob` with no type is handed on under.
 */
const DEFAULT_BINARY_CONTENT_TYPE = 'application/octet-stream'

/**
 * A decrypting cipher for one generation, as `ciphersForCollection` builds it.
 */
type ResourceCipher = {
  decrypt: (options: {
    id: string
    envelope: never
    chunkSource?: ChunkSource
  }) => Promise<unknown>
}

/**
 * What one Resource's read produced: the body the sink is handed with its
 * content type, or the error name that explains why it could not be read.
 */
type ReadResult =
  | ({ contentType: string } & ({ json: unknown } | { bytes: Uint8Array }))
  | { cause: string }

/**
 * A chunk source that holds no chunk, for an envelope with no chunk files.
 * @returns {Promise<undefined>}
 */
async function emptyChunkSource(): Promise<undefined> {
  return undefined
}

/**
 * Turns one decrypted Resource into the body the sink is handed. A `Blob` is
 * read through was-client's `blobBytes`, since a React Native `Blob` has no
 * `arrayBuffer()`.
 * @param plaintext {unknown}   what the cipher's `decrypt` resolved
 * @returns {Promise<ReadResult>}
 */
async function handedPlaintext(plaintext: unknown): Promise<ReadResult> {
  if (plaintext instanceof Blob) {
    return {
      contentType: plaintext.type || DEFAULT_BINARY_CONTENT_TYPE,
      bytes: await blobBytes(plaintext)
    }
  }
  return { contentType: 'application/json', json: plaintext }
}

/**
 * Opens one envelope, newest generation first, and reads what it decrypts to.
 * A `KeyUnwrapError` is the fallback signal -- this generation holds no key for
 * that Resource's epoch -- and the next generation is tried. That happens
 * before any chunk is read. Anything else is this Resource's answer: an
 * `UnknownEpochError` means the descriptor lists no such epoch, which no other
 * generation can change. A throw after an abort is the abort, and is rethrown
 * as the signal's reason.
 *
 * @param options {object}
 * @param options.ciphers {ResourceCipher[]}   newest generation first
 * @param options.resourceId {string}   the id the envelope is bound to
 * @param options.envelope {unknown}
 * @param [options.chunkSource] {ChunkSource}   serves a chunked envelope's
 *   chunks; absent where a chunked Resource is not opened
 * @param [options.signal] {AbortSignal}
 * @returns {Promise<ReadResult>}
 */
async function openResource({
  ciphers,
  resourceId,
  envelope,
  chunkSource,
  signal
}: {
  ciphers: ResourceCipher[]
  resourceId: string
  envelope: unknown
  chunkSource?: ChunkSource
  signal?: AbortSignal
}): Promise<ReadResult> {
  let lastCause = 'KeyUnwrapError'
  for (const cipher of ciphers) {
    try {
      return await handedPlaintext(
        await cipher.decrypt({
          id: resourceId,
          envelope: envelope as never,
          ...(chunkSource !== undefined && { chunkSource })
        })
      )
    } catch (err) {
      if (signal?.aborted) {
        throw signal.reason
      }
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
 * @param [options.chunkSource] {ChunkSource}   as {@link openResource} takes it
 * @param [options.signal] {AbortSignal}
 * @returns {Promise<ReadResult>}
 */
async function readResource({
  ciphers,
  resourceId,
  contentType,
  bytes,
  chunkSource,
  signal
}: {
  ciphers: ResourceCipher[] | undefined
  resourceId: string
  contentType: string
  bytes: Uint8Array
  chunkSource?: ChunkSource
  signal?: AbortSignal
}): Promise<ReadResult> {
  if (ciphers === undefined && !isJsonContentType(contentType)) {
    return { contentType, bytes }
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    return { cause: (err as Error).name }
  }
  if (ciphers === undefined) {
    return { contentType, json: body }
  }
  return openResource({
    ciphers,
    resourceId,
    envelope: body,
    ...(chunkSource !== undefined && { chunkSource }),
    ...(signal !== undefined && { signal })
  })
}

/**
 * A chunk source over one chunk directory's files, as the second pass gathered
 * them. It checks the abort signal on every call, serves only the directory's
 * own Resource, and drops each chunk's bytes as it serves them, so the held
 * chunk files shrink as the decrypted parts grow.
 *
 * @param options {object}
 * @param options.resourceId {string}   the Resource the directory belongs to
 * @param options.chunks {Map<number, Uint8Array>}   the chunk files' bytes,
 *   by index
 * @param [options.signal] {AbortSignal}
 * @returns {ChunkSource}
 */
function chunkSourceOver({
  resourceId,
  chunks,
  signal
}: {
  resourceId: string
  chunks: Map<number, Uint8Array>
  signal?: AbortSignal
}): ChunkSource {
  return async ({ docId, chunkIndex }) => {
    if (signal?.aborted) {
      throw signal.reason
    }
    const bytes = chunks.get(chunkIndex)
    // was-client raises its missing-chunk error for an `undefined` answer.
    if (docId !== resourceId || bytes === undefined) {
      return undefined
    }
    chunks.delete(chunkIndex)
    return JSON.parse(new TextDecoder().decode(bytes)) as NonNullable<
      Awaited<ReturnType<ChunkSource>>
    >
  }
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
 * @param options.chunked {ReadonlySet<string>}   the Resource ids the
 *   collection holds a chunk directory for
 * @param options.openChunked {boolean}   whether this walk reassembles chunked
 *   Resources: `true` only for an encrypted app collection. Otherwise each
 *   chunked Resource is counted under `ChunkedResourceUnsupportedError`
 * @param options.tally {CollectionTally}   filled in as the pass goes
 * @param [options.signal] {AbortSignal}   checked between Resources and on
 *   every chunk read
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
  openChunked,
  tally,
  signal,
  onProgress
}: {
  archive: ByteSource
  collectionId: string
  importResource: (options: AppCollectionResource) => Promise<SinkOutcome>
  ciphers: ResourceCipher[] | undefined
  chunked: ReadonlySet<string>
  openChunked: boolean
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
  const reassembles = openChunked && ciphers !== undefined
  // The chunked envelopes the first pass could not open without their chunks,
  // by Resource id: a few hundred bytes each.
  const heldEnvelopes = new Map<string, Uint8Array>()
  // The chunk directories whose Resource the first pass already counted (an
  // envelope rewritten small, a pending stub): the second pass ignores them.
  const settledDirectories = new Set<string>()

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

  /**
   * Counts one Resource no sink call saw, under the name that explains it.
   * @param cause {string}
   * @returns {void}
   */
  function countUnopenable(cause: string): void {
    tally.countUnopenable(cause)
    progress('unopenable')
  }

  /**
   * Hands one read Resource to the sink and applies the two stop rules.
   * @param options {object}
   * @param options.resourceId {string}
   * @param options.handed {ReadResult}
   * @returns {Promise<{ stopped?: string } | undefined>}   the walk's result
   *   when this Resource ended the collection or the walk, `undefined` to go
   *   on
   */
  async function deliver({
    resourceId,
    handed
  }: {
    resourceId: string
    handed: ReadResult
  }): Promise<{ stopped?: string } | undefined> {
    if ('cause' in handed) {
      countUnopenable(handed.cause)
      return undefined
    }
    let outcome: SinkOutcome
    try {
      outcome = await importResource({ collectionId, resourceId, ...handed })
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
      return undefined
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
      return undefined
    }
    consecutiveFailures = 0
    return undefined
  }

  /**
   * Opens one held chunked envelope over the chunks gathered for it, and
   * hands it on.
   * @param options {object}
   * @param options.resourceId {string}
   * @param options.envelope {Uint8Array}   the held representation's bytes
   * @param options.chunks {Map<number, Uint8Array>}
   * @returns {Promise<{ stopped?: string } | undefined>}   as
   *   {@link deliver} returns it
   */
  async function openHeld({
    resourceId,
    envelope,
    chunks
  }: {
    resourceId: string
    envelope: Uint8Array
    chunks: Map<number, Uint8Array>
  }): Promise<{ stopped?: string } | undefined> {
    if (signal?.aborted) {
      throw signal.reason
    }
    const handed = await readResource({
      ciphers,
      resourceId,
      contentType: 'application/json',
      bytes: envelope,
      chunkSource: chunkSourceOver({
        resourceId,
        chunks,
        ...(signal !== undefined && { signal })
      }),
      ...(signal !== undefined && { signal })
    })
    return deliver({ resourceId, handed })
  }

  if (!reassembles) {
    for (let count = 0; count < chunked.size; count += 1) {
      countUnopenable(ChunkedResourceUnsupportedError.name)
    }
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
    if (file.kind !== 'representation') {
      continue
    }
    const { resourceId, contentType } = file
    if (!reassembles && chunked.has(resourceId)) {
      continue
    }
    const bytes = await entry.bytes()
    const handed = await readResource({
      ciphers,
      resourceId,
      contentType,
      bytes,
      // Every Resource of an encrypted app collection gets a chunk source, so
      // a chunked envelope with no chunk directory counts as a missing chunk.
      ...(reassembles && { chunkSource: emptyChunkSource }),
      ...(signal !== undefined && { signal })
    })
    if (
      'cause' in handed &&
      handed.cause === MISSING_CHUNK_ERROR_NAME &&
      chunked.has(resourceId)
    ) {
      heldEnvelopes.set(resourceId, bytes)
      continue
    }
    if (chunked.has(resourceId)) {
      settledDirectories.add(resourceId)
    }
    const result = await deliver({ resourceId, handed })
    if (result !== undefined) {
      return result
    }
  }

  if (!reassembles || chunked.size === 0) {
    return {}
  }

  // The second pass: this collection's chunk directories, each finished when
  // the pass moves to another directory or ends.
  let group: { resourceId: string; chunks: Map<number, Uint8Array> } | undefined

  /**
   * Finishes the chunk directory the second pass holds: opens its envelope
   * over its chunks, counts it as a stray when no envelope was held for it,
   * or ignores it when the first pass already counted its Resource.
   * @returns {Promise<{ stopped?: string } | undefined>}   as
   *   {@link deliver} returns it
   */
  async function finishGroup(): Promise<{ stopped?: string } | undefined> {
    if (group === undefined) {
      return undefined
    }
    const { resourceId, chunks } = group
    group = undefined
    if (settledDirectories.has(resourceId)) {
      return undefined
    }
    const envelope = heldEnvelopes.get(resourceId)
    if (envelope === undefined) {
      // No representation beside it, or a later fragment of a directory the
      // archive split: counted once per directory.
      countUnopenable(MISSING_CHUNK_ERROR_NAME)
      return undefined
    }
    heldEnvelopes.delete(resourceId)
    return openHeld({ resourceId, envelope, chunks })
  }

  const chunkPass = await readSpaceArchive(archive)
  for await (const entry of chunkPass.entries) {
    if (signal?.aborted) {
      throw signal.reason
    }
    const position = parseArchivePath(entry.name)
    if (position.area !== 'chunk' || position.collectionId !== collectionId) {
      continue
    }
    if (group?.resourceId !== position.resourceId) {
      const result = await finishGroup()
      if (result !== undefined) {
        return result
      }
      group = { resourceId: position.resourceId, chunks: new Map() }
    }
    // Only a directory whose envelope is held has its chunks buffered.
    if (entry.type !== 'file' || !heldEnvelopes.has(group.resourceId)) {
      continue
    }
    const file = classifyCollectionFile(position.fileName)
    if (file.kind !== 'representation') {
      // A `.meta.<index>.json` sidecar, or a name the layout does not build.
      continue
    }
    const chunkIndex = parseChunkIndexSegment(file.resourceId)
    if (chunkIndex === undefined || group.chunks.has(chunkIndex)) {
      continue
    }
    group.chunks.set(chunkIndex, await entry.bytes())
  }
  const result = await finishGroup()
  if (result !== undefined) {
    return result
  }
  // An envelope whose directory yielded no entry at all is opened with no
  // chunks, so it is counted rather than dropped.
  for (const [resourceId, envelope] of [...heldEnvelopes]) {
    heldEnvelopes.delete(resourceId)
    const leftover = await openHeld({
      resourceId,
      envelope,
      chunks: new Map()
    })
    if (leftover !== undefined) {
      return leftover
    }
  }
  return {}
}
