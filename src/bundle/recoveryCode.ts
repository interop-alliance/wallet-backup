/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The packed recovery code, the bundle's `recovery-code.json` entry: the
 * account's recovery code carried inside the backup, either in the clear or
 * sealed to an export passphrase the user types at export time and again at
 * import time.
 *
 * The sealing reuses the wallet's own record construction rather than minting
 * a scheme of its own. The passphrase runs through wallet-core's Argon2id
 * unlock derivation under the keyring parameter set, but with a fresh random
 * salt per bundle, so two bundles sealed under the same passphrase share no
 * derived key and neither derivation is the wallet's own account derivation.
 * The derived standing client's key-agreement key is the sole recipient of a
 * one-epoch record descriptor, and the code is sealed into that descriptor's
 * envelope through the same encrypt-only cipher an unlock record is sealed
 * with -- no new context label is introduced, so the envelope is bound under
 * the keyring cipher context exactly as wallet-core binds it.
 */
import { base64urlnopad } from '@scure/base'
import { deriveUnlockSeed, KEYRING_KDF } from '@interop/wallet-core/keyring/kdf'
import type { UnlockKdf } from '@interop/wallet-core/keyring/kdf'
import {
  mintRecordEncryption,
  recordCipher,
  recordEnvelopeId,
  recordSealCipher
} from '@interop/wallet-core/keyring/recordEnvelope'
import { standingClientFromUnlockSeed } from '@interop/wallet-core/unlock/standingClient'
import type { CollectionEncryption } from '@interop/was-client'
import { BundleInvalidError } from '../errors.js'

/**
 * The number of random bytes in a packed code's per-bundle KDF salt.
 */
const RECOVERY_CODE_SALT_BYTES = 16

/**
 * The label the packed code's refusals name the document with.
 */
const RECOVERY_CODE_LABEL = 'recovery code'

/**
 * The `recovery-code.json` document: the code in the clear, or sealed to an
 * export passphrase.
 */
export type PackedRecoveryCode =
  | { form: 'plain'; code: string }
  | {
      form: 'sealed'
      kdf: UnlockKdf
      encryption: CollectionEncryption
      wrapped: unknown
    }

/**
 * Mints the per-bundle KDF descriptor: the keyring parameter set with a fresh
 * 16-byte random salt, base64url-nopad. The parameters come from the shared
 * constant rather than a local restatement, so a change to the wallet's
 * Argon2id cost reaches a packed code too.
 * @returns {UnlockKdf}
 */
function mintRecoveryCodeKdf(): UnlockKdf {
  const salt = base64urlnopad.encode(
    crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_SALT_BYTES))
  )
  if (KEYRING_KDF.algorithm !== 'Argon2id') {
    throw new Error('The keyring KDF is not the expected Argon2id parameters.')
  }
  return { ...KEYRING_KDF, salt }
}

/**
 * Derives the key-agreement key a packed code is sealed to and opened with:
 * the standing client identity of the export passphrase under the document's
 * own KDF descriptor.
 *
 * The Argon2id seed is handed back beside the agents rather than dropped here,
 * so each caller can wipe it once it is done: the seed is the export
 * passphrase's whole strength, and both the sealing and the opening path hold
 * it only for the one derivation below.
 *
 * @param options {object}
 * @param options.exportPassphrase {string}
 * @param options.kdf {UnlockKdf}
 * @returns {Promise<{ agents: import('@interop/was-client/identity').ProfileAgents, unlockSeed: Uint8Array }>}
 */
async function recoveryCodeAgents({
  exportPassphrase,
  kdf
}: {
  exportPassphrase: string
  kdf: UnlockKdf
}) {
  const unlockSeed = await deriveUnlockSeed({ secret: exportPassphrase, kdf })
  const client = await standingClientFromUnlockSeed({ unlockSeed })
  return { agents: client.agents, unlockSeed }
}

/**
 * Packs a recovery code for a backup bundle. Without an export passphrase the
 * code is carried in the clear (the bundle itself is then the secret); with
 * one, it is sealed and the bundle carries nothing openable on its own.
 * @param options {object}
 * @param options.code {string}   the account's recovery code
 * @param [options.exportPassphrase] {string}   seals the code when given
 * @returns {Promise<PackedRecoveryCode>}
 */
export async function packRecoveryCode({
  code,
  exportPassphrase
}: {
  code: string
  exportPassphrase?: string
}): Promise<PackedRecoveryCode> {
  if (exportPassphrase === undefined) {
    return { form: 'plain', code }
  }
  const kdf = mintRecoveryCodeKdf()
  const { agents, unlockSeed } = await recoveryCodeAgents({
    exportPassphrase,
    kdf
  })
  try {
    const encryption = await mintRecordEncryption({
      keyAgreementKey: agents.keyAgreementKey
    })
    const cipher = await recordSealCipher({ encryption })
    const { envelope } = await cipher.encrypt({ data: { code } })
    return { form: 'sealed', kdf, encryption, wrapped: envelope }
  } finally {
    unlockSeed.fill(0)
  }
}

/**
 * Validates a packed code document's frame.
 * @param document {unknown}
 * @returns {PackedRecoveryCode}
 */
function parsePackedRecoveryCode(document: unknown): PackedRecoveryCode {
  if (document === null || typeof document !== 'object') {
    throw new BundleInvalidError(
      `The packed ${RECOVERY_CODE_LABEL} is not an object.`
    )
  }
  const packed = document as Partial<PackedRecoveryCode>
  if (packed.form === 'plain') {
    if (typeof packed.code !== 'string' || !packed.code) {
      throw new BundleInvalidError(
        `The packed ${RECOVERY_CODE_LABEL} carries no code.`
      )
    }
    return { form: 'plain', code: packed.code }
  }
  if (packed.form !== 'sealed') {
    throw new BundleInvalidError(
      `The packed ${RECOVERY_CODE_LABEL} carries an unknown form.`
    )
  }
  if (!packed.kdf || !packed.encryption || packed.wrapped === undefined) {
    throw new BundleInvalidError(
      `The sealed ${RECOVERY_CODE_LABEL} is missing its kdf, encryption, or ` +
        `wrapped member.`
    )
  }
  return {
    form: 'sealed',
    kdf: packed.kdf,
    encryption: packed.encryption,
    wrapped: packed.wrapped
  }
}

/**
 * Reads a packed recovery code back. A plain document yields its code
 * directly; a sealed one is opened with the export passphrase it was sealed
 * under, and refuses under was-client's `KeyUnwrapError` for any other
 * passphrase (a different passphrase derives a different key-agreement key,
 * which the sealed epoch has no wrap for).
 * @param options {object}
 * @param options.document {unknown}   the parsed `recovery-code.json`
 * @param [options.exportPassphrase] {string}   required for a sealed document
 * @returns {Promise<string>}   the recovery code
 */
export async function unpackRecoveryCode({
  document,
  exportPassphrase
}: {
  document: unknown
  exportPassphrase?: string
}): Promise<string> {
  const packed = parsePackedRecoveryCode(document)
  if (packed.form === 'plain') {
    return packed.code
  }
  if (exportPassphrase === undefined) {
    throw new BundleInvalidError(
      `The packed ${RECOVERY_CODE_LABEL} is sealed and no export passphrase ` +
        `was supplied.`
    )
  }
  const { agents, unlockSeed } = await recoveryCodeAgents({
    exportPassphrase,
    kdf: packed.kdf
  })
  try {
    const cipher = await recordCipher({
      keyAgreementKey: agents.keyAgreementKey,
      keyResolver: agents.keyResolver,
      encryption: packed.encryption
    })
    const plaintext = (await cipher.decrypt({
      id: recordEnvelopeId({
        wrapped: packed.wrapped,
        label: RECOVERY_CODE_LABEL
      }),
      envelope: packed.wrapped as never
    })) as { code?: unknown }
    if (typeof plaintext.code !== 'string' || !plaintext.code) {
      throw new BundleInvalidError(
        `The sealed ${RECOVERY_CODE_LABEL} carries no code.`
      )
    }
    return plaintext.code
  } finally {
    unlockSeed.fill(0)
  }
}
