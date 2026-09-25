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
import { collectBytes, EXPORT_ENTRY_MTIME } from '@interop/space-archive'
import type { ByteSource } from '@interop/space-archive'
import {
  buildBundleManifest,
  spaceArchivePath,
  BUNDLE_MANIFEST_FILE,
  BACKUP_CREDENTIAL_FILE,
  SPACES_DIRECTORY
} from './manifest.js'
import type { BundleMeta } from './manifest.js'

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
 * Packs a backup bundle. Entries are emitted in manifest order (the manifest,
 * the packed backup credential when present, then the `spaces/` directory and
 * its archives), every header pinned to the epoch `mtime` the Space archives
 * use, so a bundle over unchanged inputs is byte-reproducible.
 *
 * A Space archive handed as a stream is drained one Space at a time: a tar
 * header carries its entry's size, so the bytes have to be in hand before the
 * entry is written.
 *
 * The pack is finalized before it is returned, with no consumer attached, so
 * the whole bundle is buffered in the pack's own backpressure queue until the
 * caller drains it. A host that saves to a file therefore sees the file appear
 * only once the export has finished. WBU-5 tracks the streaming writer that
 * writes entries as the consumer drains.
 *
 * @param options {object}
 * @param options.meta {BundleMeta}   the bundle's provenance
 * @param options.spaces {BundleSpaceInput[]}   the Space archives, in pack
 *   order
 * @param [options.backupCredential] {object}   the packed backup credential
 *   document (see `packBackupCredential`); no `backup-credential.json` entry
 *   is emitted without it
 * @returns {Promise<tar.Pack>}   the finalized tar-stream pack
 */
export async function writeBundle({
  meta,
  spaces,
  backupCredential
}: {
  meta: BundleMeta
  spaces: BundleSpaceInput[]
  backupCredential?: unknown
}): Promise<tar.Pack> {
  const manifest = buildBundleManifest({
    meta,
    spaces: spaces.map(space => ({ spaceId: space.spaceId, role: space.role })),
    backupCredential: backupCredential !== undefined
  })

  const mtime = EXPORT_ENTRY_MTIME
  const pack = tar.pack()
  pack.entry({ name: BUNDLE_MANIFEST_FILE, mtime }, YAML.stringify(manifest))
  if (backupCredential !== undefined) {
    pack.entry(
      { name: BACKUP_CREDENTIAL_FILE, mtime },
      JSON.stringify(backupCredential)
    )
  }
  pack.entry({ name: `${SPACES_DIRECTORY}/`, type: 'directory', mtime })
  for (const space of spaces) {
    pack.entry(
      { name: spaceArchivePath(space.spaceId), mtime },
      await collectBytes(space.archive)
    )
  }
  pack.finalize()
  return pack
}
