/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The outer bundle's `manifest.yml`: the FEP-6fcd manifest that names what a
 * backup bundle holds, and the role URLs its `contents` entries are annotated
 * with. Those URLs are permanent wire text -- a reader finds the account Space
 * archive by matching the `#account-space-archive` anchor, and nothing else in
 * the bundle marks which tar is which -- so they live here as named constants
 * and are never rewritten.
 */
import { UBC_MANIFEST_URL } from '@interop/space-archive'

/**
 * The bundle's own manifest file name, the first entry of every bundle.
 */
export const BUNDLE_MANIFEST_FILE = 'manifest.yml'

/**
 * The packed recovery code's file name, an optional top-level entry.
 */
export const RECOVERY_CODE_FILE = 'recovery-code.json'

/**
 * The directory holding one per-Space export archive per Space.
 */
export const SPACES_DIRECTORY = 'spaces'

/**
 * The Portable Wallet Profile's rendered location, the base every role anchor
 * below hangs off.
 */
export const PROFILE_SPEC_URL =
  'https://interop-alliance.github.io/portable-wallet-profile-spec/'

/**
 * The `spec` member of a bundle manifest: which profile the bundle is written
 * to, at which version, and where that profile is published.
 */
export const BUNDLE_SPEC = {
  id: 'https://w3id.org/pws/wallet-profile',
  version: '0.1',
  url: PROFILE_SPEC_URL
} as const

/**
 * The role a `contents` entry's `url` names: which part of the profile the
 * entry plays. `spaceArchives` annotates the `spaces/` directory itself; the
 * three Space roles annotate one `spaces/<spaceId>.tar` each; and
 * `packedRecoveryCode` annotates `recovery-code.json`.
 */
export const BUNDLE_ROLE = {
  spaceArchives: `${PROFILE_SPEC_URL}#space-archives`,
  accountSpaceArchive: `${PROFILE_SPEC_URL}#account-space-archive`,
  clientAnnexSpaceArchive: `${PROFILE_SPEC_URL}#client-annex-space-archive`,
  unlockSpaceArchive: `${PROFILE_SPEC_URL}#unlock-space-archive`,
  packedRecoveryCode: `${PROFILE_SPEC_URL}#packed-recovery-code`
} as const

/**
 * One of the three roles a Space archive entry may carry.
 */
export type BundleSpaceRole =
  | typeof BUNDLE_ROLE.accountSpaceArchive
  | typeof BUNDLE_ROLE.clientAnnexSpaceArchive
  | typeof BUNDLE_ROLE.unlockSpaceArchive

/**
 * The bundle's provenance: when it was written, by which account controller,
 * and with which client. Carries no version member of its own -- the manifest's
 * `ubc-version` and `spec` cover that.
 */
export interface BundleMeta {
  created: string
  createdBy: {
    controller: string
    client: { name: string; url: string }
  }
}

/**
 * A bundle's parsed `manifest.yml`.
 */
export interface BundleManifest {
  'ubc-version': string
  meta: BundleMeta
  spec: { id: string; version: string; url: string }
  contents: Record<string, unknown>
}

/**
 * The manifest minus its `contents`: everything a host needs to describe the
 * bundle it just read (who wrote it, when, to which profile) without carrying
 * the file tree around.
 */
export type BundleManifestSummary = Omit<BundleManifest, 'contents'>

/**
 * Strips a manifest down to its summary members.
 * @param manifest {BundleManifest}
 * @returns {BundleManifestSummary}
 */
export function bundleManifestSummary(
  manifest: BundleManifest
): BundleManifestSummary {
  return {
    'ubc-version': manifest['ubc-version'],
    meta: manifest.meta,
    spec: manifest.spec
  }
}

/**
 * The archive file name one Space's export archive is stored under.
 * @param spaceId {string}
 * @returns {string}
 */
export function spaceArchivePath(spaceId: string): string {
  return `${SPACES_DIRECTORY}/${spaceId}.tar`
}

/**
 * Builds the bundle's manifest document: the FEP-6fcd `contents` tree over the
 * manifest itself, the optional packed recovery code, and the `spaces/`
 * directory with one role-annotated entry per Space, in the order they are
 * packed.
 * @param options {object}
 * @param options.meta {BundleMeta}
 * @param options.spaces {Array<{ spaceId: string, role: string }>}   the Space
 *   archives, in pack order
 * @param [options.recoveryCode] {boolean}   whether the bundle carries a
 *   `recovery-code.json` entry
 * @returns {BundleManifest}
 */
export function buildBundleManifest({
  meta,
  spaces,
  recoveryCode = false
}: {
  meta: BundleMeta
  spaces: { spaceId: string; role: string }[]
  recoveryCode?: boolean
}): BundleManifest {
  return {
    'ubc-version': '0.1',
    meta,
    spec: { ...BUNDLE_SPEC },
    contents: {
      [BUNDLE_MANIFEST_FILE]: { url: UBC_MANIFEST_URL },
      ...(recoveryCode && {
        [RECOVERY_CODE_FILE]: { url: BUNDLE_ROLE.packedRecoveryCode }
      }),
      [SPACES_DIRECTORY]: {
        url: BUNDLE_ROLE.spaceArchives,
        contents: spaces.map(space => ({
          [`${space.spaceId}.tar`]: { url: space.role }
        }))
      }
    }
  }
}

/**
 * Reads the `url` off one FEP `contents` entry, which is either a single-key
 * object mapping a file name to its annotation, or a bare file-name string
 * (annotated with nothing).
 * @param entry {unknown}
 * @returns {{ name: string, url?: string } | undefined}
 */
function contentsEntry(
  entry: unknown
): { name: string; url?: string } | undefined {
  if (typeof entry === 'string') {
    return { name: entry }
  }
  if (entry === null || typeof entry !== 'object') {
    return undefined
  }
  const [name] = Object.keys(entry)
  if (name === undefined) {
    return undefined
  }
  const value = (entry as Record<string, unknown>)[name]
  const url =
    value !== null && typeof value === 'object'
      ? (value as { url?: unknown }).url
      : undefined
  return typeof url === 'string' ? { name, url } : { name }
}

/**
 * Indexes a manifest's Space archive entries by their archive path, so a
 * reader can tell which `spaces/<spaceId>.tar` carries which role before it
 * has read a single Space archive.
 * @param manifest {BundleManifest}
 * @returns {Map<string, string>}   archive path to role url
 */
export function spaceArchiveRoles(
  manifest: BundleManifest
): Map<string, string> {
  const roles = new Map<string, string>()
  const spaces = manifest.contents[SPACES_DIRECTORY] as
    { contents?: unknown } | undefined
  const contents = spaces?.contents
  if (!Array.isArray(contents)) {
    return roles
  }
  for (const entry of contents) {
    const parsed = contentsEntry(entry)
    if (parsed?.url) {
      roles.set(`${SPACES_DIRECTORY}/${parsed.name}`, parsed.url)
    }
  }
  return roles
}
