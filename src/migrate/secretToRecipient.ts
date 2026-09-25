/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One old secret to the recipient identity the archived user key roster wraps
 * to. Three secrets reach the same shape. An unlock passphrase runs through
 * the keyring's Argon2id derivation to the standing client identity. A
 * recovery code typed by hand runs through its own HKDF client derivation.
 * The backup credential the bundle itself packs (in the clear, or sealed to an
 * export passphrase) is unpacked to its 32 secret bytes, which run through
 * the backup credential's HKDF derivation to its standing client identity.
 *
 * Every derivation here belongs to `@interop/wallet-core`; this module
 * chooses between them and hands back the key-agreement key the roster lookup
 * matches on, plus the passphrase's intermediate seed so the walk can wipe it
 * when it ends.
 */
import {
  BACKUP_CREDENTIAL_KDF,
  KEYRING_KDF
} from '@interop/wallet-core/keyring/kdf'
import { recoveryClientFromCode } from '@interop/wallet-core/recovery/recoveryCode'
import { BundleInvalidError } from '../errors.js'
import { unpackBackupCredential } from '../bundle/backupCredential.js'
import { BACKUP_CREDENTIAL_FILE } from '../bundle/manifest.js'
import { standingAgentsFromSecret } from '../standingAgents.js'
import type { StandingAgents } from '../standingAgents.js'

/**
 * The old secret a migration is run with: the account's unlock passphrase, its
 * recovery code, or the backup credential the bundle itself carries -- plain,
 * or sealed under the export passphrase typed at export time.
 */
export type MigrationSecret =
  | { passphrase: string }
  | { recoveryCode: string }
  | { packedCredential: { exportPassphrase?: string } }

/**
 * A reader's key-agreement key, as wallet-core's own client derivations hand
 * it back. Taken off one of those derivations rather than imported from the
 * key interface's package, which this package does not depend on directly.
 */
export type RecipientKeyAgreementKey = StandingAgents['keyAgreementKey']

/**
 * The derived recipient: the key-agreement key whose id the roster's wraps are
 * addressed to, and the unlock seed behind it where one was derived, held only
 * so the walk can zero it at the end.
 */
export interface MigrationRecipient {
  keyAgreementKey: RecipientKeyAgreementKey
  unlockSeed?: Uint8Array
}

/**
 * Reads the bundle's `backup-credential.json` and opens it.
 * @param options {object}
 * @param options.files {Map<string, Uint8Array>}   the bundle's top-level files
 * @param [options.exportPassphrase] {string}   required for a sealed document
 * @returns {Promise<Uint8Array>}   the credential's secret bytes
 */
async function backupCredentialFromBundle({
  files,
  exportPassphrase
}: {
  files: Map<string, Uint8Array>
  exportPassphrase?: string
}): Promise<Uint8Array> {
  const bytes = files.get(BACKUP_CREDENTIAL_FILE)
  if (bytes === undefined) {
    throw new BundleInvalidError(
      `The bundle carries no "${BACKUP_CREDENTIAL_FILE}" entry.`
    )
  }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    throw new BundleInvalidError(
      `The bundle's "${BACKUP_CREDENTIAL_FILE}" is not valid JSON.`,
      { cause: err }
    )
  }
  return unpackBackupCredential({ document, exportPassphrase })
}

/**
 * Derives the roster recipient one migration secret stands for.
 *
 * The packed credential's secret bytes and the unlock seed derived from them
 * are wiped before this returns: the key-agreement key is derived from them
 * already, and nothing past this point needs either. Only the passphrase's
 * unlock seed is handed on, for the walk to wipe when it ends.
 *
 * @param options {object}
 * @param options.secret {MigrationSecret}
 * @param options.files {Map<string, Uint8Array>}   the bundle's top-level
 *   files, read only by the packed-credential secret
 * @returns {Promise<MigrationRecipient>}
 */
export async function recipientFromSecret({
  secret,
  files
}: {
  secret: MigrationSecret
  files: Map<string, Uint8Array>
}): Promise<MigrationRecipient> {
  if ('passphrase' in secret) {
    const { agents, unlockSeed } = await standingAgentsFromSecret({
      secret: secret.passphrase,
      kdf: KEYRING_KDF
    })
    return { keyAgreementKey: agents.keyAgreementKey, unlockSeed }
  }
  if ('recoveryCode' in secret) {
    const client = await recoveryClientFromCode({ code: secret.recoveryCode })
    return { keyAgreementKey: client.agents.keyAgreementKey }
  }
  const credentialSecret = await backupCredentialFromBundle({
    files,
    exportPassphrase: secret.packedCredential.exportPassphrase
  })
  try {
    const { agents, unlockSeed } = await standingAgentsFromSecret({
      secret: credentialSecret,
      kdf: BACKUP_CREDENTIAL_KDF
    })
    unlockSeed.fill(0)
    return { keyAgreementKey: agents.keyAgreementKey }
  } finally {
    credentialSecret.fill(0)
  }
}
