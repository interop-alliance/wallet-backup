/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The user key generations a secret recovers, and the ciphers they open a
 * collection with.
 *
 * Every roster epoch is one generation of the account's user key, escrow-
 * wrapped to every enrolled recipient, so one old secret recovers the whole
 * history rather than the epoch it was enrolled at. The walk needs them all:
 * a cascade that tore halfway leaves the newest generation opening some
 * collections' epochs and an older one the rest, and a Resource is opened by
 * whichever generation holds its epoch.
 *
 * Generations arrive oldest first and are reversed here, because the newest is
 * the one most Resources open under and every fallback costs a failed unwrap.
 *
 * The same ciphers also open an encrypted collection's archived metadata
 * `custom` envelope, for the blinded-index schema it carries.
 */
import { userKeyVaultKeys } from '@interop/wallet-core/keys/userKey'
import { unwrapUserKeyGenerations } from '@interop/wallet-core/keys/userKeyGenerations'
import { createEdvDocCipher } from '@interop/was-client/edv/core'
import type { EdvDocCipher } from '@interop/was-client/edv/core'
import type { CollectionEncryption, IndexSchema } from '@interop/was-client'
import { BundleRecipientMissingError } from '../errors.js'
import type { RecipientKeyAgreementKey } from './secretToRecipient.js'

/**
 * One user key generation: the did:key naming it and its raw secret. The
 * secret is live key material for as long as the walk holds it, and is zeroed
 * when the walk ends.
 */
export type UserKeyGeneration = Awaited<
  ReturnType<typeof unwrapUserKeyGenerations>
>[number]

/**
 * Recovers every user key generation the secret's recipient key holds a wrap
 * for, newest first. A secret that is a recipient of none is not a recipient
 * of this bundle at all, which is refused here -- before a single Resource is
 * decrypted, so a wrong passphrase fails the whole walk rather than emptying
 * it Resource by Resource.
 *
 * @param options {object}
 * @param options.descriptor {CollectionEncryption}   the archived roster
 * @param options.keyAgreementKey {RecipientKeyAgreementKey}   the recipient
 *   derived from the secret
 * @returns {Promise<UserKeyGeneration[]>}   newest generation first
 */
export async function recoverGenerations({
  descriptor,
  keyAgreementKey
}: {
  descriptor: CollectionEncryption
  keyAgreementKey: RecipientKeyAgreementKey
}): Promise<UserKeyGeneration[]> {
  const generations = await unwrapUserKeyGenerations({
    descriptor,
    clientKeyAgreementKey: keyAgreementKey
  })
  if (generations.length === 0) {
    throw new BundleRecipientMissingError(
      'The secret is not a recipient of the archived user key roster: it ' +
        'unwraps no generation of the account user key.'
    )
  }
  return [...generations].reverse()
}

/**
 * Builds one decrypting cipher per generation for one collection, newest first.
 * A generation that is a recipient of no epoch of this collection is left out
 * rather than fatal: on a torn cascade that is the normal state, and the
 * generations that do open epochs still open their Resources. A generation
 * whose entry in the current epoch names it but fails its key-wrap check is
 * different: that is a tamper signal for this collection's descriptor, and
 * the cipher's `IntegrityError` is not mistaken for a non-recipient. The
 * generation is dropped and named in `dropped`, so the report can carry the
 * signal, and the collection still opens with the generations whose entries
 * are sound. Only when no generation survives does the signal travel, as the
 * first `IntegrityError` raised, and the collection is stopped under it. An
 * entry that names a generation only in an older epoch is unwrapped on first
 * use, so its failure arrives at the Resource instead. Any other construction
 * failure is a wiring fault and travels untouched. No `spaceId` is passed, so
 * the cipher builds no transport and the migration issues no request.
 *
 * @param options {object}
 * @param options.generations {UserKeyGeneration[]}   newest first
 * @param options.collectionId {string}
 * @param options.encryption {CollectionEncryption}   the collection's
 *   descriptor, read from its archived governing log
 * @returns {Promise<{ ciphers: EdvDocCipher[]; dropped: string[] }>}   the
 *   ciphers that built, newest first, and the error name of each generation
 *   dropped for failing its key-wrap check
 */
export async function ciphersForCollection({
  generations,
  collectionId,
  encryption
}: {
  generations: UserKeyGeneration[]
  collectionId: string
  encryption: CollectionEncryption
}): Promise<{ ciphers: EdvDocCipher[]; dropped: string[] }> {
  const ciphers: EdvDocCipher[] = []
  const dropped: string[] = []
  let firstIntegrityError: Error | undefined
  for (const generation of generations) {
    const { keyAgreementKey, keyResolver } = userKeyVaultKeys({
      userKey: generation
    })
    try {
      ciphers.push(
        await createEdvDocCipher({
          keyAgreementKey,
          keyResolver,
          collectionId,
          encryption
        })
      )
    } catch (err) {
      // A generation that is a recipient of no epoch here refuses at
      // construction, and a kid-matched entry that fails its key-wrap check
      // drops the generation. Every other cause is a wiring fault.
      const name = (err as Error).name
      if (name === 'IntegrityError') {
        dropped.push(name)
        firstIntegrityError ??= err as Error
      } else if (name !== 'KeyUnwrapError') {
        throw err
      }
    }
  }
  if (ciphers.length === 0 && firstIntegrityError !== undefined) {
    throw firstIntegrityError
  }
  return { ciphers, dropped }
}

/**
 * Recovers the blinded-index schema from a collection's archived metadata
 * `custom` envelope, newest generation first. A generation whose cipher holds
 * no blinding key, or cannot unwrap the envelope's epoch, yields to the next.
 * The envelope is bound to the collection id the ciphers were built for, so
 * one sealed for another collection is not opened.
 *
 * A schema that cannot be recovered refuses nothing: the collection still
 * migrates, with no `indexSchema`, as it does for a schema that declares no
 * index. What ended the attempt is named in `cause`, the error name, so the
 * report can carry it; an `IntegrityError` there is a tamper signal, from a
 * generation's epoch entry that names it but fails its key-wrap check or from
 * an envelope that does not authenticate, and no older generation is tried
 * after it. Only the name is handed on, since the envelope's contents are
 * secret.
 *
 * @param options {object}
 * @param options.ciphers {EdvDocCipher[]}   newest generation first
 * @param options.custom {unknown}   the archived metadata's `custom` value
 * @returns {Promise<{ indexSchema?: IndexSchema; cause?: string }>}   the
 *   schema when one was recovered and declares an index; otherwise the error
 *   name that ended the attempt, or neither when every generation yielded or
 *   the schema declares no index
 */
export async function indexSchemaFromCustom({
  ciphers,
  custom
}: {
  ciphers: EdvDocCipher[]
  custom: unknown
}): Promise<{ indexSchema?: IndexSchema; cause?: string }> {
  for (const cipher of ciphers) {
    let schema: IndexSchema
    try {
      schema = await cipher.applyMeta({ custom })
    } catch (err) {
      if ((err as Error).name === 'KeyUnwrapError') {
        continue
      }
      return { cause: (err as Error).name }
    }
    if (schema.indexes.length > 0) {
      return { indexSchema: schema }
    }
  }
  return {}
}

/**
 * Wipes every generation's secret in place. Called from the walk's `finally`,
 * so an abort or a refusal drops the key material as an ordinary end does.
 * @param generations {UserKeyGeneration[]}
 * @returns {void}
 */
export function zeroGenerations(generations: UserKeyGeneration[]): void {
  for (const generation of generations) {
    generation.secret.fill(0)
  }
}
