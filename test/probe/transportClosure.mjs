/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The package evaluates no transport module. Everything it takes from
 * `@interop/wallet-core` and `@interop/was-client` is offline work -- a KDF, a
 * record cipher, a client derivation, a user key unwrap, a doc cipher -- and
 * each is imported from the leaf entry that carries it without the transport
 * graph beside it. This script imports the built package entry under a Node
 * resolve hook, records every module Node actually resolves, and fails when
 * one of them is a was-client module that talks to a server, was-client's
 * `./edv` or root barrel, or a wallet-core module past the offline leaves. It
 * runs against `dist/`, as part of `pnpm run test:dist`, so it also sees what
 * a dependency package loads on its own.
 *
 * Known allowance: the standing client and recovery client derivations load
 * `@interop/was-client/identity`, which brings `@interop/ezcap`,
 * `@interop/capability-agent` and the HTTP signing packages behind them. That
 * is wallet-core's own recorded allowance for its leaves, so the HTTP packages
 * are not in the forbidden set here; the was-client request path is.
 */
import { registerHooks } from 'node:module'

const FORBIDDEN_MODULES = [
  '/was-client/dist/index.js',
  '/was-client/dist/WasClient.js',
  '/was-client/dist/Space.js',
  '/was-client/dist/Collection.js',
  '/was-client/dist/Resource.js',
  '/was-client/dist/internal/request.js',
  '/was-client/dist/edv/index.js',
  '/was-client/dist/edv/WasTransport.js',
  '/was-client/dist/edv/transportFactory.js',
  '/wallet-core/dist/index.js',
  '/wallet-core/dist/space/index.js',
  '/wallet-core/dist/space/provisioning.js',
  '/wallet-core/dist/space/deleteSpace.js',
  '/wallet-core/dist/resourceLog/',
  '/wallet-core/dist/clientAnnex/'
]

const resolved = new Set()
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolved.add(result.url)
    return result
  }
})

await import(new URL('../../dist/index.js', import.meta.url))

const failures = [...resolved].filter(url =>
  FORBIDDEN_MODULES.some(fragment => url.includes(fragment))
)
if (failures.length > 0) {
  console.error('The package entry reaches transport modules at runtime:')
  for (const failure of failures) {
    console.error(`  ${failure}`)
  }
  process.exit(1)
}
console.log(`transport closure: ${resolved.size} modules resolved, none transport`)
