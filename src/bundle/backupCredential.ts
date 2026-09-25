/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The packed backup credential, the bundle's `backup-credential.json` entry:
 * the 32 secret bytes of a standing unlock credential the wallet established
 * for this backup, carried inside the bundle. They travel in the clear, or
 * sealed to an export passphrase the user types at export time and again at
 * import time. The wallet establishes the credential; this module only packs
 * its secret and reads it back.
 *
 * The secret is serialized as base64url without padding, in a `secret`
 * member. A reader derives the credential's standing identity from those
 * bytes through wallet-core's `BACKUP_CREDENTIAL_KDF`.
 *
 * The sealing reuses the wallet's own record construction rather than minting
 * a scheme of its own. The passphrase runs through wallet-core's Argon2id
 * unlock derivation under the keyring parameter set, but with a fresh random
 * salt per bundle, so two bundles sealed under the same passphrase share no
 * derived key and neither derivation is the wallet's own account derivation.
 * The derived standing client's key-agreement key is the sole recipient of a
 * one-epoch record descriptor, and the secret is sealed into that descriptor's
 * envelope through the same encrypt-only cipher an unlock record is sealed
 * with. No new context label is introduced, so the envelope is bound under
 * the keyring cipher context exactly as wallet-core binds it.
 */
import { base64urlnopad } from '@scure/base'
import { KEYRING_KDF } from '@interop/wallet-core/keyring/kdf'
import type { UnlockKdf } from '@interop/wallet-core/keyring/kdf'
import {
  mintRecordEncryption,
  recordCipher,
  recordEnvelopeId,
  recordSealCipher
} from '@interop/wallet-core/keyring/recordEnvelope'
import type { CollectionEncryption } from '@interop/was-client'
import { BundleInvalidError } from '../errors.js'
import { standingAgentsFromSecret } from '../standingAgents.js'
import type { StandingAgents } from '../standingAgents.js'

/**
 * The number of random bytes in a sealed document's per-bundle KDF salt.
 */
const EXPORT_KDF_SALT_BYTES = 16

/**
 * The number of bytes in a backup credential's secret.
 */
const BACKUP_CREDENTIAL_SECRET_BYTES = 32

/**
 * The label the packed credential's refusals and envelope id name the
 * document with.
 */
const BACKUP_CREDENTIAL_LABEL = 'backup credential'

/**
 * The `backup-credential.json` document: the secret in the clear, or sealed
 * to an export passphrase.
 */
export type PackedBackupCredential =
  | { form: 'plain'; secret: string }
  | {
      form: 'sealed'
      kdf: UnlockKdf
      encryption: CollectionEncryption
      wrapped: unknown
    }

/**
 * The keyring parameter set a sealed document's passphrase runs through,
 * without the keyring's own salt. The parameters come from the shared
 * constant rather than a local restatement, so a change to the wallet's
 * Argon2id cost reaches a sealed document too.
 * @returns {Omit<Extract<UnlockKdf, { algorithm: 'Argon2id' }>, 'salt'>}
 */
function exportKdfParameters(): Omit<
  Extract<UnlockKdf, { algorithm: 'Argon2id' }>,
  'salt'
> {
  if (KEYRING_KDF.algorithm !== 'Argon2id') {
    throw new Error('The keyring KDF is not the expected Argon2id parameters.')
  }
  const { salt: _keyringSalt, ...parameters } = KEYRING_KDF
  return parameters
}

/**
 * Mints the per-bundle KDF descriptor the export passphrase runs through: the
 * keyring parameter set with a fresh 16-byte random salt, base64url-nopad.
 * @returns {UnlockKdf}
 */
function mintExportKdf(): UnlockKdf {
  const salt = base64urlnopad.encode(
    crypto.getRandomValues(new Uint8Array(EXPORT_KDF_SALT_BYTES))
  )
  return { ...exportKdfParameters(), salt }
}

/**
 * Derives the key-agreement key a sealed document is sealed to and opened
 * with: the standing client identity of the export passphrase under the
 * document's own KDF descriptor.
 *
 * The Argon2id seed is the export passphrase's whole strength. It is zeroed
 * here before the agents are returned: the key-agreement key is built from it
 * already, and neither the sealing nor the opening path needs it past this
 * derivation.
 *
 * @param options {object}
 * @param options.exportPassphrase {string}
 * @param options.kdf {UnlockKdf}
 * @returns {Promise<StandingAgents>}
 */
async function exportPassphraseAgents({
  exportPassphrase,
  kdf
}: {
  exportPassphrase: string
  kdf: UnlockKdf
}): Promise<StandingAgents> {
  const { agents, unlockSeed } = await standingAgentsFromSecret({
    secret: exportPassphrase,
    kdf
  })
  unlockSeed.fill(0)
  return agents
}

/**
 * Validates a sealed document's KDF descriptor against the keyring parameter
 * set the export passphrase is meant to run through. The descriptor is
 * bundle-supplied, so without this check a tampered bundle would choose the
 * algorithm and the Argon2id cost the reader pays before any wrap is tried.
 * Only the salt may differ, since it is minted per bundle.
 * @param kdf {unknown}
 * @returns {UnlockKdf}
 */
function parseExportKdf(kdf: unknown): UnlockKdf {
  if (kdf === null || typeof kdf !== 'object') {
    throw new BundleInvalidError(
      `The sealed ${BACKUP_CREDENTIAL_LABEL}'s kdf is not an object.`
    )
  }
  const { salt } = kdf as { salt?: unknown }
  if (typeof salt !== 'string' || !salt) {
    throw new BundleInvalidError(
      `The sealed ${BACKUP_CREDENTIAL_LABEL}'s kdf carries no salt.`
    )
  }
  const expected = exportKdfParameters()
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = (kdf as Record<string, unknown>)[key]
    if (actual !== wanted) {
      throw new BundleInvalidError(
        `The sealed ${BACKUP_CREDENTIAL_LABEL}'s kdf is not the keyring ` +
          `parameter set: "${key}" is ${JSON.stringify(actual)}, ` +
          `not ${JSON.stringify(wanted)}.`
      )
    }
  }
  return { ...expected, salt }
}

/**
 * Decodes a serialized secret back to its bytes, refusing anything that is
 * not base64url-nopad or not exactly 32 bytes long.
 * @param secret {unknown}
 * @returns {Uint8Array}
 */
function decodeSecret(secret: unknown): Uint8Array {
  if (typeof secret !== 'string' || !secret) {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL} carries no secret.`
    )
  }
  let bytes: Uint8Array
  try {
    bytes = base64urlnopad.decode(secret)
  } catch (err) {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL}'s secret is not base64url ` +
        `without padding.`,
      { cause: err }
    )
  }
  if (bytes.length !== BACKUP_CREDENTIAL_SECRET_BYTES) {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL}'s secret is ${bytes.length} ` +
        `bytes, not ${BACKUP_CREDENTIAL_SECRET_BYTES}.`
    )
  }
  return bytes
}

/**
 * Packs a backup credential's secret for a backup bundle. Without an export
 * passphrase the secret is carried in the clear (the bundle itself is then
 * the secret); with one, it is sealed and the bundle carries nothing openable
 * on its own.
 * @param options {object}
 * @param options.secret {Uint8Array}   the credential's 32 secret bytes
 * @param [options.exportPassphrase] {string}   seals the secret when given
 * @returns {Promise<PackedBackupCredential>}
 */
export async function packBackupCredential({
  secret,
  exportPassphrase
}: {
  secret: Uint8Array
  exportPassphrase?: string
}): Promise<PackedBackupCredential> {
  if (secret.length !== BACKUP_CREDENTIAL_SECRET_BYTES) {
    throw new Error(
      `A backup credential's secret is ${BACKUP_CREDENTIAL_SECRET_BYTES} ` +
        `bytes; got ${secret.length}.`
    )
  }
  const encoded = base64urlnopad.encode(secret)
  if (exportPassphrase === undefined) {
    return { form: 'plain', secret: encoded }
  }
  const kdf = mintExportKdf()
  const agents = await exportPassphraseAgents({ exportPassphrase, kdf })
  const encryption = await mintRecordEncryption({
    keyAgreementKey: agents.keyAgreementKey
  })
  const cipher = await recordSealCipher({ encryption })
  const { envelope } = await cipher.encrypt({ data: { secret: encoded } })
  return { form: 'sealed', kdf, encryption, wrapped: envelope }
}

/**
 * Validates a sealed document's frame: its KDF descriptor against the keyring
 * parameter set, and the presence of its encryption and wrapped members.
 * @param packed {object}
 * @returns {Extract<PackedBackupCredential, { form: 'sealed' }>}
 */
function parseSealedBackupCredential(
  packed: Partial<{
    kdf: unknown
    encryption: CollectionEncryption
    wrapped: unknown
  }>
): Extract<PackedBackupCredential, { form: 'sealed' }> {
  if (!packed.kdf || !packed.encryption || packed.wrapped === undefined) {
    throw new BundleInvalidError(
      `The sealed ${BACKUP_CREDENTIAL_LABEL} is missing its kdf, ` +
        `encryption, or wrapped member.`
    )
  }
  return {
    form: 'sealed',
    kdf: parseExportKdf(packed.kdf),
    encryption: packed.encryption,
    wrapped: packed.wrapped
  }
}

/**
 * Reads a packed backup credential back to its 32 secret bytes. A plain
 * document yields its secret directly. A sealed one is opened with the export
 * passphrase it was sealed under, and refuses under was-client's
 * `KeyUnwrapError` for any other passphrase: a different passphrase derives a
 * different key-agreement key, which the sealed epoch has no wrap for. A
 * secret that is not base64url-nopad, or not 32 bytes, is refused with
 * `BundleInvalidError`, as is a sealed document whose KDF descriptor is not
 * the keyring parameter set under a per-bundle salt; the check runs before
 * any derivation, so a tampered descriptor buys no Argon2id work.
 * @param options {object}
 * @param options.document {unknown}   the parsed `backup-credential.json`
 * @param [options.exportPassphrase] {string}   required for a sealed document
 * @returns {Promise<Uint8Array>}   the credential's secret bytes
 */
export async function unpackBackupCredential({
  document,
  exportPassphrase
}: {
  document: unknown
  exportPassphrase?: string
}): Promise<Uint8Array> {
  if (document === null || typeof document !== 'object') {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL} is not an object.`
    )
  }
  const packed = document as Partial<{
    form: unknown
    secret: unknown
    kdf: unknown
    encryption: CollectionEncryption
    wrapped: unknown
  }>
  if (packed.form === 'plain') {
    return decodeSecret(packed.secret)
  }
  if (packed.form !== 'sealed') {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL} carries an unknown form.`
    )
  }
  const sealed = parseSealedBackupCredential(packed)
  if (exportPassphrase === undefined) {
    throw new BundleInvalidError(
      `The packed ${BACKUP_CREDENTIAL_LABEL} is sealed and no export ` +
        `passphrase was supplied.`
    )
  }
  const agents = await exportPassphraseAgents({
    exportPassphrase,
    kdf: sealed.kdf
  })
  const cipher = await recordCipher({
    keyAgreementKey: agents.keyAgreementKey,
    keyResolver: agents.keyResolver,
    encryption: sealed.encryption
  })
  const plaintext = (await cipher.decrypt({
    id: recordEnvelopeId({
      wrapped: sealed.wrapped,
      label: BACKUP_CREDENTIAL_LABEL
    }),
    envelope: sealed.wrapped as never
  })) as { secret?: unknown }
  return decodeSecret(plaintext.secret)
}
