/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The bundle writer: one tar holding the manifest, the optional packed
 * backup credential, and one per-Space export archive per Space, verbatim. The
 * Space archives are copied byte for byte -- a bundle is a container, not a
 * re-encoding, so an archive a WAS server exported is the same bytes a reader
 * takes back out.
 */
import * as tar from 'tar-stream'
import YAML from 'yaml'
import {
  byteChunks,
  collectBytes,
  EXPORT_ENTRY_MTIME
} from '@interop/space-archive'
import type { ByteSource } from '@interop/space-archive'
import {
  buildBundleManifest,
  spaceArchivePath,
  BUNDLE_MANIFEST_FILE,
  BACKUP_CREDENTIAL_FILE,
  SPACES_DIRECTORY
} from './manifest.js'
import type { BundleManifest, BundleMeta } from './manifest.js'

/**
 * How many Space archives the writer collects at once: the one whose entry is
 * written next, and the ones after it. A fixed number, since only the writer
 * sees the consumer's backpressure.
 */
const SPACE_ARCHIVES_IN_FLIGHT = 3

/**
 * One Space in a bundle: its id, the role it plays (a {@link BUNDLE_ROLE}
 * value), and its export archive's bytes.
 */
export interface BundleSpaceInput {
  spaceId: string
  role: string
  archive: ByteSource
}

/**
 * Packs a backup bundle as a stream. Entries are emitted in manifest order
 * (the manifest, the packed backup credential when present, then the
 * `spaces/` directory and its archives), every header pinned to the epoch
 * `mtime` the Space archives use, so a bundle over unchanged inputs is
 * byte-reproducible.
 *
 * The stream is returned before the Space entries are written, and each entry
 * is written as the consumer drains. A tar header carries its entry's size, so
 * a Space archive is collected whole before its entry is written. At most
 * three archives are collected at once, the next entry's and the two after
 * it, so an archive handed as a lazy stream (an async generator, say) is not
 * read until the writer is within that window of it. A consumer that stops
 * reading stops the writer, and with it the collection of later archives.
 *
 * An archive source that fails errors the stream with its error, rather than
 * ending it as a truncated tar. Cancelling the stream, a failed entry, or an
 * abort of `signal` stops the writer. It then starts no further collection,
 * and an archive already being collected is released at its next chunk. An
 * abort errors the stream with the signal's reason at any point before its
 * last byte is read.
 *
 * @param options {object}
 * @param options.meta {BundleMeta}   the bundle's provenance
 * @param options.spaces {BundleSpaceInput[]}   the Space archives, in pack
 *   order
 * @param [options.backupCredential] {object}   the packed backup credential
 *   document (see `packBackupCredential`); no `backup-credential.json` entry
 *   is emitted without it
 * @param [options.settle] {function}   called once every Space's archive is
 *   in hand, before the last Space entry is written; not called once the
 *   writer has stopped, and a throw errors the stream
 * @param [options.signal] {AbortSignal}   stops the writer and errors the
 *   stream with its `reason`
 * @returns {ReadableStream<Uint8Array>}   the bundle's bytes
 */
export function writeBundle({
  meta,
  spaces,
  backupCredential,
  settle,
  signal
}: {
  meta: BundleMeta
  spaces: BundleSpaceInput[]
  backupCredential?: unknown
  settle?: () => Promise<void>
  signal?: AbortSignal
}): ReadableStream<Uint8Array> {
  const manifest = buildBundleManifest({
    meta,
    spaces: spaces.map(space => ({ spaceId: space.spaceId, role: space.role })),
    backupCredential: backupCredential !== undefined
  })
  const pack = tar.pack()
  const stopped = new AbortController()
  /**
   * Stops the writer once: marks it stopped, so collections and `settle`
   * see it, and destroys the pack, erroring the stream with `reason` when it
   * is an error.
   * @param [reason] {unknown}
   * @returns {void}
   */
  function stop(reason?: unknown): void {
    if (stopped.signal.aborted) {
      return
    }
    stopped.abort(reason)
    pack.destroy(reason instanceof Error ? reason : undefined)
  }
  /**
   * @returns {void}
   */
  function aborted(): void {
    stop(signal!.reason)
  }
  if (signal?.aborted) {
    stop(signal.reason)
  } else {
    signal?.addEventListener('abort', aborted, { once: true })
    pack.once('close', () => signal?.removeEventListener('abort', aborted))
  }
  writeEntries({
    pack,
    manifest,
    spaces,
    backupCredential,
    settle,
    stopped: stopped.signal
  }).catch(stop)
  return streamFromPack({ pack, stop })
}

/**
 * Writes the bundle's entries into the pack and finalizes it, each entry
 * awaited until the pack has taken its bytes and has room for more.
 *
 * @param options {object}
 * @param options.pack {tar.Pack}
 * @param options.manifest {BundleManifest}
 * @param options.spaces {BundleSpaceInput[]}
 * @param [options.backupCredential] {object}
 * @param [options.settle] {function}
 * @param options.stopped {AbortSignal}   aborted once the writer stops
 * @returns {Promise<void>}
 */
async function writeEntries({
  pack,
  manifest,
  spaces,
  backupCredential,
  settle,
  stopped
}: {
  pack: tar.Pack
  manifest: BundleManifest
  spaces: BundleSpaceInput[]
  backupCredential?: unknown
  settle?: () => Promise<void>
  stopped: AbortSignal
}): Promise<void> {
  const mtime = EXPORT_ENTRY_MTIME
  await writeEntry({
    pack,
    header: { name: BUNDLE_MANIFEST_FILE, mtime },
    body: YAML.stringify(manifest)
  })
  if (backupCredential !== undefined) {
    await writeEntry({
      pack,
      header: { name: BACKUP_CREDENTIAL_FILE, mtime },
      body: JSON.stringify(backupCredential)
    })
  }
  await writeEntry({
    pack,
    header: { name: `${SPACES_DIRECTORY}/`, type: 'directory', mtime }
  })

  const archives: Promise<Uint8Array>[] = []
  /**
   * Starts collecting the archive at `index`, if there is one. A collection
   * the writer never reaches (an earlier entry failed) is marked handled, so
   * its own failure is not reported as unhandled.
   * @param index {number}
   * @returns {void}
   */
  function startCollecting(index: number): void {
    const space = spaces[index]
    if (space === undefined) {
      return
    }
    const collected = collectBytes(untilStopped(space.archive, stopped))
    collected.catch(() => {})
    archives.push(collected)
  }
  for (let index = 0; index < SPACE_ARCHIVES_IN_FLIGHT; index++) {
    startCollecting(index)
  }
  for (const [index, space] of spaces.entries()) {
    const body = await archives[index]!
    if (index === spaces.length - 1) {
      await settleOnce({ settle, stopped })
    }
    await writeEntry({
      pack,
      header: { name: spaceArchivePath(space.spaceId), mtime },
      body
    })
    startCollecting(index + SPACE_ARCHIVES_IN_FLIGHT)
  }
  if (spaces.length === 0) {
    await settleOnce({ settle, stopped })
  }
  pack.finalize()
}

/**
 * Runs the host's `settle` check, unless the writer has already stopped, and
 * refuses to go on if the writer stopped while it ran.
 *
 * @param options {object}
 * @param [options.settle] {function}
 * @param options.stopped {AbortSignal}
 * @returns {Promise<void>}
 */
async function settleOnce({
  settle,
  stopped
}: {
  settle?: () => Promise<void>
  stopped: AbortSignal
}): Promise<void> {
  stopped.throwIfAborted()
  await settle?.()
  stopped.throwIfAborted()
}

/**
 * An archive source's chunks, until the writer stops. The chunk read after a
 * stop ends the read, which releases the source (a generator is returned, a
 * web stream cancelled) and fails the collection, so the archive is dropped
 * rather than held.
 *
 * @param source {ByteSource}
 * @param stopped {AbortSignal}
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* untilStopped(
  source: ByteSource,
  stopped: AbortSignal
): AsyncGenerator<Uint8Array> {
  stopped.throwIfAborted()
  for await (const chunk of byteChunks(source)) {
    stopped.throwIfAborted()
    yield chunk
  }
}

/**
 * Writes one entry and settles once the pack has taken its bytes with room to
 * spare, which is the pack's drain signal: an entry whose bytes fill the
 * pack's queue settles only after the consumer has read some of it.
 *
 * @param options {object}
 * @param options.pack {tar.Pack}
 * @param options.header {object}   the tar header
 * @param [options.body] {string | Uint8Array}   the entry's bytes; none for a
 *   directory
 * @returns {Promise<void>}
 */
async function writeEntry({
  pack,
  header,
  body
}: {
  pack: tar.Pack
  header: Parameters<tar.Pack['entry']>[0]
  body?: string | Uint8Array
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    /**
     * @param [err] {Error | null}
     * @returns {void}
     */
    function written(err?: Error | null): void {
      if (err) {
        reject(err)
        return
      }
      resolve()
    }
    const sink =
      body === undefined
        ? pack.entry(header, written)
        : pack.entry(header, body, written)
    // A pack destroyed mid-entry destroys the entry too. Its error reaches
    // `written` as well, so the entry's own `error` event is only observed.
    sink.on('error', () => {})
  })
}

/**
 * The pack as a web stream, pulled one chunk at a time. A consumer that
 * cancels stops the writer.
 *
 * @param options {object}
 * @param options.pack {tar.Pack}
 * @param options.stop {function}   stops the writer and destroys the pack
 * @returns {ReadableStream<Uint8Array>}
 */
function streamFromPack({
  pack,
  stop
}: {
  pack: tar.Pack
  stop: (reason?: unknown) => void
}): ReadableStream<Uint8Array> {
  // tar-stream types a pack's chunks as `any`; every one is a `Uint8Array`,
  // which the pack's own writers guarantee.
  const chunks = (pack as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    async cancel(reason) {
      stop(reason)
      await chunks.return?.()
    }
  })
}
