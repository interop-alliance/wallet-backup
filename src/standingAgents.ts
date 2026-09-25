/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * One unlock secret to the standing client agents it derives, with the
 * derivation's byproducts wiped. Both the packed backup credential (sealing
 * and opening under an export passphrase) and the migration walk (an unlock
 * passphrase, the unpacked credential secret) run the same two wallet-core
 * steps, an unlock seed derivation and the standing client derivation over
 * that seed, and owe the same wipe: the client seed and binding MAC key the
 * standing client derivation hands back beside its agents are zeroed here,
 * so no caller has to remember them. The unlock seed is handed back with the
 * agents, since one caller keeps it for the walk to wipe at the end; every
 * other caller zeroes it as soon as this returns.
 */
import { deriveUnlockSeed } from '@interop/wallet-core/keyring/kdf'
import type { UnlockKdf } from '@interop/wallet-core/keyring/kdf'
import { standingClientFromUnlockSeed } from '@interop/wallet-core/unlock/standingClient'

/**
 * The agents a standing client derivation hands back.
 */
export type StandingAgents = Awaited<
  ReturnType<typeof standingClientFromUnlockSeed>
>['agents']

/**
 * Derives the standing client agents an unlock secret stands for under the
 * given KDF descriptor. The client seed and binding MAC key are zeroed before
 * the agents are returned; the unlock seed is zeroed only when the client
 * derivation fails, and is otherwise the caller's to wipe.
 * @param options {object}
 * @param options.secret {string | Uint8Array}   the unlock secret
 * @param options.kdf {UnlockKdf}   the descriptor the secret runs through
 * @returns {Promise<{ agents: StandingAgents, unlockSeed: Uint8Array }>}
 */
export async function standingAgentsFromSecret({
  secret,
  kdf
}: {
  secret: string | Uint8Array
  kdf: UnlockKdf
}): Promise<{ agents: StandingAgents; unlockSeed: Uint8Array }> {
  const unlockSeed = await deriveUnlockSeed({ secret, kdf })
  let client: Awaited<ReturnType<typeof standingClientFromUnlockSeed>>
  try {
    client = await standingClientFromUnlockSeed({ unlockSeed })
  } catch (err) {
    unlockSeed.fill(0)
    throw err
  }
  client.clientSeed.fill(0)
  client.bindingMacKey.fill(0)
  return { agents: client.agents, unlockSeed }
}
