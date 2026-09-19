/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import { packRecoveryCode, unpackRecoveryCode } from '../../src/index.js'
import type { PackedRecoveryCode } from '../../src/index.js'

const code = 'z3fixtureRecoveryCodeValue'
const exportPassphrase = 'correct horse battery staple'

/**
 * Reads the name of the error a thunk raises.
 * @param run {Function}
 * @returns {Promise<string>}
 */
async function errorName(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    return (err as Error).name
  }
  throw new Error('The call did not throw.')
}

/**
 * Narrows a packed document to its sealed form.
 * @param packed {PackedRecoveryCode}
 * @returns {Extract<PackedRecoveryCode, { form: 'sealed' }>}
 */
function sealed(
  packed: PackedRecoveryCode
): Extract<PackedRecoveryCode, { form: 'sealed' }> {
  if (packed.form !== 'sealed') {
    throw new Error('The packed code is not sealed.')
  }
  return packed
}

describe('packRecoveryCode and unpackRecoveryCode', () => {
  it('round-trips a plain code', async () => {
    const packed = await packRecoveryCode({ code })
    expect(packed).toEqual({ form: 'plain', code })
    expect(await unpackRecoveryCode({ document: packed })).toBe(code)
  })

  it('round-trips a sealed code', async () => {
    const packed = sealed(await packRecoveryCode({ code, exportPassphrase }))
    expect(packed.kdf.algorithm).toBe('Argon2id')
    expect(packed.encryption.epochs).toHaveLength(1)
    expect(JSON.stringify(packed)).not.toContain(code)
    expect(
      await unpackRecoveryCode({ document: packed, exportPassphrase })
    ).toBe(code)
  })

  it('refuses a sealed code under the wrong export passphrase', async () => {
    const packed = await packRecoveryCode({ code, exportPassphrase })
    expect(
      await errorName(() =>
        unpackRecoveryCode({ document: packed, exportPassphrase: 'wrong one' })
      )
    ).toBe('KeyUnwrapError')
  })

  it('refuses a sealed code with no export passphrase', async () => {
    const packed = await packRecoveryCode({ code, exportPassphrase })
    expect(
      await errorName(() => unpackRecoveryCode({ document: packed }))
    ).toBe('BundleInvalidError')
  })

  it('mints a fresh salt per bundle', async () => {
    const first = sealed(await packRecoveryCode({ code, exportPassphrase }))
    const second = sealed(await packRecoveryCode({ code, exportPassphrase }))
    expect(first.kdf.salt).not.toBe(second.kdf.salt)
    // 16 random bytes, base64url without padding.
    expect(first.kdf.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(first.kdf.salt).not.toBe('freewallet/keyring/unlock/argon2id/v1')
  })

  it('will not open under a substituted salt', async () => {
    const packed = sealed(await packRecoveryCode({ code, exportPassphrase }))
    const edited = {
      ...packed,
      kdf: { ...packed.kdf, salt: 'AAAAAAAAAAAAAAAAAAAAAA' }
    }
    expect(
      await errorName(() =>
        unpackRecoveryCode({ document: edited, exportPassphrase })
      )
    ).toBe('KeyUnwrapError')
  })

  it('refuses a malformed document', async () => {
    expect(await errorName(() => unpackRecoveryCode({ document: null }))).toBe(
      'BundleInvalidError'
    )
    expect(
      await errorName(() => unpackRecoveryCode({ document: { form: 'other' } }))
    ).toBe('BundleInvalidError')
  })
})
