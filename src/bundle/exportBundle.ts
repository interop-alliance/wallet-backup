/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The export ceremony: the ordered sequence that turns a live account into a
 * self-sufficient backup bundle. The package owns the order; the host owns
 * every effect it reaches for, handed in as a port -- the wallet's own code
 * issuance, its Space listing, and the server's per-Space export primitive.
 * Nothing here issues a request or names a transport, so the ceremony runs
 * the same in a browser wallet and in a mobile one.
 *
 * The order is the invariant. The recovery code is minted FIRST, through the
 * wallet's issuance ceremony, which writes the code's own unlock Space and a
 * document entry. Only then is the account's Space list read, so the list
 * already names that unlock Space and the bundle carries the Space the packed
 * code opens. A list read first would leave a bundle whose code locates a
 * Space the bundle does not hold.
 *
 * A Space export that fails fails the whole ceremony. A bundle silently
 * missing one sibling Space reads as complete and is not, which is worse than
 * no bundle at all.
 *
 * The code string does not outlive the call. It is held for the one
 * `packRecoveryCode` call and dropped when the ceremony ends -- never
 * returned, never stored on a field.
 */
import * as tar from 'tar-stream'
import { byteChunks } from '@interop/space-archive'
import type { ByteSource } from '@interop/space-archive'
import { BUNDLE_ROLE } from './manifest.js'
import type { BundleMeta } from './manifest.js'
import { packRecoveryCode } from './recoveryCode.js'
import { writeBundle } from './writeBundle.js'
import { AccountSpaceArchiveMissingError } from '../errors.js'

/**
 * The stage an export ceremony reports: minting the account's recovery code,
 * exporting one Space (which names the Space), and packing the bundle.
 */
export type ExportStage = 'issuing-code' | 'exporting-space' | 'packing'

/**
 * Throws the signal's reason when a caller has aborted the ceremony. Called
 * between stages, so an abort lands on a stage boundary rather than inside a
 * host's own effect.
 * @param [signal] {AbortSignal}
 * @returns {void}
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason
  }
}

/**
 * Runs the export ceremony and hands back the packed bundle.
 *
 * The stages run in exactly this order: the recovery code is issued, the
 * account's Spaces are listed, each listed Space is exported in the order
 * listed, and the bundle is packed. Each Space is exported only when the
 * packer reaches it, so one Space's archive is collected at a time. The pack
 * itself is another matter: `writeBundle` finalizes it with no consumer
 * attached, so the finished bundle sits in memory until the caller drains it
 * (WBU-5 makes the writer stream).
 *
 * @param options {object}
 * @param options.meta {BundleMeta}   the bundle's provenance
 * @param options.issueRecoveryCode {function}   mints and registers a recovery
 *   code in the account, and answers the code string
 * @param options.listSpaces {function}   answers every Space the account
 *   names, each with a {@link BUNDLE_ROLE} role; called only once the code has
 *   been issued
 * @param options.exportSpace {function}   the server's per-Space export
 *   primitive, answering one Space's archive bytes
 * @param [options.exportPassphrase] {string}   seals the packed code when
 *   given; without it the code is packed in the clear
 * @param [options.onProgress] {function}   called at each stage with
 *   `{ stage, spaceId }`, the `spaceId` present on `exporting-space` alone
 * @param [options.signal] {AbortSignal}   checked between stages; the ceremony
 *   throws its `reason`
 * @returns {Promise<tar.Pack>}   the finalized tar-stream pack, for the host
 *   to pipe wherever the file goes
 */
export async function exportBundle({
  meta,
  issueRecoveryCode,
  listSpaces,
  exportSpace,
  exportPassphrase,
  onProgress,
  signal
}: {
  meta: BundleMeta
  issueRecoveryCode: () => Promise<string>
  listSpaces: () => Promise<{ spaceId: string; role: string }[]>
  exportSpace: (options: {
    spaceId: string
    role: string
  }) => Promise<ByteSource>
  exportPassphrase?: string
  onProgress?: (options: { stage: ExportStage; spaceId?: string }) => void
  signal?: AbortSignal
}): Promise<tar.Pack> {
  throwIfAborted(signal)
  onProgress?.({ stage: 'issuing-code' })
  const recoveryCode = await packRecoveryCode({
    code: await issueRecoveryCode(),
    exportPassphrase
  })

  throwIfAborted(signal)
  const spaces = await listSpaces()
  if (!spaces.some(space => space.role === BUNDLE_ROLE.accountSpaceArchive)) {
    throw new AccountSpaceArchiveMissingError(
      'The account names no account Space, so this export would write a ' +
        'bundle nothing can be read out of.'
    )
  }

  /**
   * Exports one Space when the packer reaches it, so the ceremony collects one
   * archive at a time and a failure names the Space it happened on. The last
   * Space's source reports the `packing` stage as it ends, since the packer
   * writes the final entry once it has these bytes.
   * @param space {{ spaceId: string, role: string }}
   * @param last {boolean}
   * @returns {AsyncGenerator<Uint8Array>}
   */
  async function* archiveOf(
    space: { spaceId: string; role: string },
    last: boolean
  ): AsyncGenerator<Uint8Array> {
    throwIfAborted(signal)
    onProgress?.({ stage: 'exporting-space', spaceId: space.spaceId })
    try {
      yield* byteChunks(await exportSpace(space))
    } catch (err) {
      throw new Error(`Exporting Space "${space.spaceId}" failed.`, {
        cause: err
      })
    }
    if (last) {
      onProgress?.({ stage: 'packing' })
    }
  }

  return writeBundle({
    meta,
    spaces: spaces.map((space, index) => ({
      spaceId: space.spaceId,
      role: space.role,
      archive: archiveOf(space, index === spaces.length - 1)
    })),
    recoveryCode
  })
}
