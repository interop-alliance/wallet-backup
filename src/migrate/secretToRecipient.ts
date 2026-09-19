/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One old secret to the recipient identity the archived user key roster wraps
 * to. Three secrets reach the same shape: an unlock passphrase through the
 * keyring's Argon2id derivation and the standing client identity, a recovery
 * code through its own HKDF client derivation, and a packed code out of the
 * bundle itself (in the clear, or sealed to an export passphrase) which is
 * then a recovery code like any other.
 *
 * Every derivation here belongs to `@interop/wallet-core`; this module
 * chooses between them and hands back the key-agreement key the roster lookup
 * matches on, plus the intermediate seed so the walk can wipe it when it ends.
 */
import { deriveUnlockSeed, KEYRING_KDF } from '@interop/wallet-core/keyring'
import { standingClientFromUnlockSeed } from '@interop/wallet-core/unlock'
import { recoveryClientFromCode } from '@interop/wallet-core/recovery'
import { BundleInvalidError } from '../errors.js'
import { unpackRecoveryCode } from '../bundle/recoveryCode.js'
import { RECOVERY_CODE_FILE } from '../bundle/manifest.js'

/**
 * The old secret a migration is run with: the account's unlock passphrase, its
 * recovery code, or the recovery code the bundle itself carries -- plain, or
 * sealed under the export passphrase typed at export time.
 */
export type MigrationSecret =
  | { passphrase: string }
  | { recoveryCode: string }
  | { packedCode: { exportPassphrase?: string } }

/**
 * A reader's key-agreement key, as wallet-core's own client derivations hand
 * it back. Taken off one of those derivations rather than imported from the
 * key interface's package, which this package does not depend on directly.
 */
export type RecipientKeyAgreementKey = Awaited<
  ReturnType<typeof standingClientFromUnlockSeed>
>['agents']['keyAgreementKey']

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
 * Reads the bundle's `recovery-code.json` and opens it.
 * @param options {object}
 * @param options.files {Map<string, Uint8Array>}   the bundle's top-level files
 * @param [options.exportPassphrase] {string}   required for a sealed document
 * @returns {Promise<string>}   the recovery code
 */
async function recoveryCodeFromBundle({
  files,
  exportPassphrase
}: {
  files: Map<string, Uint8Array>
  exportPassphrase?: string
}): Promise<string> {
  const bytes = files.get(RECOVERY_CODE_FILE)
  if (bytes === undefined) {
    throw new BundleInvalidError(
      `The bundle carries no "${RECOVERY_CODE_FILE}" entry.`
    )
  }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    throw new BundleInvalidError(
      `The bundle's "${RECOVERY_CODE_FILE}" is not valid JSON.`,
      { cause: err }
    )
  }
  return unpackRecoveryCode({ document, exportPassphrase })
}

/**
 * Derives the roster recipient one migration secret stands for.
 *
 * @param options {object}
 * @param options.secret {MigrationSecret}
 * @param options.files {Map<string, Uint8Array>}   the bundle's top-level
 *   files, read only by the packed-code secret
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
    const unlockSeed = await deriveUnlockSeed({
      secret: secret.passphrase,
      kdf: KEYRING_KDF
    })
    const client = await standingClientFromUnlockSeed({ unlockSeed })
    return { keyAgreementKey: client.agents.keyAgreementKey, unlockSeed }
  }
  const code =
    'recoveryCode' in secret
      ? secret.recoveryCode
      : await recoveryCodeFromBundle({
          files,
          exportPassphrase: secret.packedCode.exportPassphrase
        })
  const client = await recoveryClientFromCode({ code })
  return { keyAgreementKey: client.agents.keyAgreementKey }
}
