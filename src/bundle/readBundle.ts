/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The bundle reader: the manifest and the small top-level files eagerly (they
 * are packed first and are tiny), then the Space archives as a one-shot lazy
 * walk. A Space archive is the one large thing in a bundle, so exactly one of
 * them is ever in memory, and a reader after a single Space stops walking as
 * soon as it has it.
 */
import {
  BundleInvalidError,
  AccountSpaceArchiveMissingError
} from '../errors.js'
import { parseArchiveManifest, tarEntries } from '@interop/space-archive'
import type { ByteSource, TarEntry } from '@interop/space-archive'
import {
  spaceArchiveRoles,
  BUNDLE_MANIFEST_FILE,
  BUNDLE_ROLE,
  SPACES_DIRECTORY
} from './manifest.js'
import type { BundleManifest, BundleMeta } from './manifest.js'

/**
 * One Space archive entry of an opened bundle: where it sits, which Space it
 * holds, the role the manifest gave it, and its archive bytes on demand.
 */
export interface BundleSpaceEntry {
  path: string
  spaceId: string
  role: string | undefined
  bytes: () => Promise<Uint8Array>
}

/**
 * An opened bundle.
 */
export interface Bundle {
  manifest: BundleManifest
  /**
   * the small top-level files, e.g. `recovery-code.json`, by file name. Only
   * the ones packed ahead of the `spaces/` directory are read.
   */
  files: Map<string, Uint8Array>
  /** the archive path of each Space archive to the role the manifest gave it */
  roles: Map<string, string>
  /** the Space archives, in archive order; walked once */
  spaces: AsyncIterable<BundleSpaceEntry>
  /**
   * releases the source; for a caller that stops before `spaces` is walked to
   * its end. Safe to call more than once.
   */
  close: () => Promise<void>
}

/**
 * Reads the manifest members a bundle must carry beyond `ubc-version`, which
 * the shared UBC parse already checked. Neither is load-bearing for opening
 * the bundle, so a missing one is filled in rather than refused: the refusals
 * this reader raises are about bytes it cannot read, not about provenance a
 * writer left thin.
 * @param manifest {object}
 * @returns {{ meta: BundleMeta, spec: BundleManifest['spec'] }}
 */
function manifestProvenance(manifest: Record<string, unknown>): {
  meta: BundleMeta
  spec: BundleManifest['spec']
} {
  const meta = (manifest.meta ?? {}) as BundleMeta
  const spec = (manifest.spec ?? {}) as BundleManifest['spec']
  return { meta, spec }
}

/**
 * Opens a backup bundle: reads its `manifest.yml` and every top-level file
 * ahead of the `spaces/` directory, then hands back the Space archives as a
 * lazy walk.
 *
 * Refuses with `BundleInvalidError` when the bytes are not a tar, the archive
 * does not open with a `manifest.yml`, the manifest is not parseable YAML, or
 * it carries no `ubc-version`.
 *
 * @param source {ByteSource}   the bundle's tar bytes, or a stream of them
 * @returns {Promise<Bundle>}
 */
export async function readBundle(source: ByteSource): Promise<Bundle> {
  const walk = tarEntries(source)
  let first: IteratorResult<TarEntry>
  try {
    first = await walk.next()
  } catch (err) {
    throw new BundleInvalidError('The bundle is not a readable tar archive.', {
      cause: err
    })
  }
  if (first.done || first.value.name !== BUNDLE_MANIFEST_FILE) {
    await walk.return(undefined)
    throw new BundleInvalidError(
      `The bundle does not open with a "${BUNDLE_MANIFEST_FILE}" entry.`
    )
  }
  let manifest: BundleManifest
  const files = new Map<string, Uint8Array>()
  let pending: TarEntry | undefined
  try {
    const text = new TextDecoder().decode(await first.value.bytes())
    const parsed = parseArchiveManifest({ text, label: 'bundle' })
    const { meta, spec } = manifestProvenance(
      parsed as unknown as Record<string, unknown>
    )
    manifest = {
      'ubc-version': parsed['ubc-version'],
      meta,
      spec,
      contents: parsed.contents
    }

    // Everything ahead of the `spaces/` directory is a small top-level file,
    // so it is read now; the first `spaces/` entry is held back for the walk.
    for (;;) {
      const next = await walk.next()
      if (next.done) {
        break
      }
      if (next.value.name.startsWith(`${SPACES_DIRECTORY}/`)) {
        pending = next.value
        break
      }
      if (next.value.type === 'file') {
        files.set(next.value.name, await next.value.bytes())
      }
    }
  } catch (err) {
    // A refusal past the first entry leaves the tar walk open, and with it
    // the source; tear it down before the refusal travels.
    await walk.return(undefined)
    throw err
  }

  const roles = spaceArchiveRoles(manifest)

  async function* spaces(): AsyncGenerator<BundleSpaceEntry> {
    try {
      let entry = pending
      while (entry !== undefined) {
        // Only a file under `spaces/` is a Space archive. Anything else that
        // turns up this late is passed over rather than read as one.
        if (
          entry.type === 'file' &&
          entry.name.startsWith(`${SPACES_DIRECTORY}/`)
        ) {
          const fileName = entry.name.slice(SPACES_DIRECTORY.length + 1)
          yield {
            path: entry.name,
            spaceId: fileName.replace(/\.tar$/, ''),
            role: roles.get(entry.name),
            bytes: entry.bytes
          }
        }
        const next = await walk.next()
        entry = next.done ? undefined : next.value
      }
    } finally {
      // The walk is advanced by hand, so a consumer that stops early has to
      // be passed on by hand too.
      await walk.return(undefined)
    }
  }

  /**
   * Tears the tar walk down. A generator that was never started runs no
   * `finally`, so a caller that refuses before iterating `spaces` closes the
   * bundle through here.
   * @returns {Promise<void>}
   */
  async function close(): Promise<void> {
    await walk.return(undefined)
  }

  return { manifest, files, roles, spaces: spaces(), close }
}

/**
 * Finds the bundle's account Space archive and reads its bytes: the entry the
 * manifest gave the `#account-space-archive` role. Refuses with
 * `AccountSpaceArchiveMissingError` when the manifest names none, or when it
 * names one the bundle does not hold.
 *
 * Consumes the bundle's Space walk up to that entry, so it is called once, and
 * before any other walk of `bundle.spaces`.
 *
 * @param bundle {Bundle}
 * @returns {Promise<Uint8Array>}
 */
export async function accountSpaceArchive(bundle: Bundle): Promise<Uint8Array> {
  const named = [...bundle.roles.entries()].filter(
    ([, role]) => role === BUNDLE_ROLE.accountSpaceArchive
  )
  if (named.length === 0) {
    await bundle.close()
    throw new AccountSpaceArchiveMissingError(
      'The bundle manifest names no account Space archive.'
    )
  }
  for await (const space of bundle.spaces) {
    if (space.role === BUNDLE_ROLE.accountSpaceArchive) {
      // Read the bytes before leaving the walk: breaking out of it tears the
      // extraction down, and the entry's body has to be in hand by then.
      const bytes = await space.bytes()
      return bytes
    }
  }
  const [[path]] = named as [[string, string]]
  throw new AccountSpaceArchiveMissingError(
    `The bundle does not hold the account Space archive "${path}" its ` +
      `manifest names.`
  )
}
