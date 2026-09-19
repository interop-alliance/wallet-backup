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
 * collections' epochs and an older one the rest, and a row is opened by
 * whichever generation holds its epoch.
 *
 * Generations arrive oldest first and are reversed here, because the newest is
 * the one most rows open under and every fallback costs a failed unwrap.
 */
import {
  unwrapUserKeyGenerations,
  userKeyVaultKeys
} from '@interop/wallet-core/keys'
import { createEdvDocCipher } from '@interop/was-client/edv/core'
import type { CollectionEncryption } from '@interop/was-client'
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
 * of this bundle at all, which is refused here -- before a single row is
 * decrypted, so a wrong passphrase fails the whole walk rather than emptying
 * it row by row.
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
 * Builds one decrypting cipher per generation for one collection, newest
 * first. A generation that is a recipient of no epoch of this collection is
 * left out rather than fatal: on a torn cascade that is the normal state, and
 * the generations that do open epochs still open their rows. No `spaceId` is
 * passed, so the cipher builds no transport and the walk issues no request.
 *
 * @param options {object}
 * @param options.generations {UserKeyGeneration[]}   newest first
 * @param options.collectionId {string}
 * @param options.encryption {CollectionEncryption}   the collection's
 *   descriptor, read from its archived governing log
 * @returns {Promise<Array<{ decrypt: (options: { id: string, envelope: never }) => Promise<unknown> }>>}
 */
export async function ciphersForCollection({
  generations,
  collectionId,
  encryption
}: {
  generations: UserKeyGeneration[]
  collectionId: string
  encryption: CollectionEncryption
}): Promise<
  Array<{
    decrypt: (options: { id: string; envelope: never }) => Promise<unknown>
  }>
> {
  const ciphers = []
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
      // construction; every other cause is a real wiring fault and travels.
      if ((err as Error).name !== 'KeyUnwrapError') {
        throw err
      }
    }
  }
  return ciphers
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
