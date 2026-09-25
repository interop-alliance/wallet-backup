/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { base64urlnopad } from '@scure/base'
import {
  packBackupCredential,
  unpackBackupCredential
} from '../../src/index.js'
import type { PackedBackupCredential } from '../../src/index.js'

const secret = crypto.getRandomValues(new Uint8Array(32))
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
 * @param packed {PackedBackupCredential}
 * @returns {Extract<PackedBackupCredential, { form: 'sealed' }>}
 */
function sealed(
  packed: PackedBackupCredential
): Extract<PackedBackupCredential, { form: 'sealed' }> {
  if (packed.form !== 'sealed') {
    throw new Error('The packed credential is not sealed.')
  }
  return packed
}

describe('packBackupCredential and unpackBackupCredential', () => {
  // One sealed document for every test that only reads it; each Argon2id
  // seal is the expensive part, and the tampering tests copy before editing.
  let sealedPacked: Extract<PackedBackupCredential, { form: 'sealed' }>
  beforeAll(async () => {
    sealedPacked = sealed(
      await packBackupCredential({ secret, exportPassphrase })
    )
  })

  it('round-trips 32 bytes through a plain document', async () => {
    const packed = await packBackupCredential({ secret })
    expect(packed).toEqual({
      form: 'plain',
      secret: base64urlnopad.encode(secret)
    })
    // 32 bytes, base64url without padding.
    expect((packed as { secret: string }).secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const unpacked = await unpackBackupCredential({
      document: JSON.parse(JSON.stringify(packed))
    })
    expect(unpacked).toEqual(secret)
    expect(unpacked).toHaveLength(32)
  })

  it('round-trips 32 bytes through a sealed document', async () => {
    const packed = sealedPacked
    expect(Object.keys(packed).sort()).toEqual([
      'encryption',
      'form',
      'kdf',
      'wrapped'
    ])
    expect(packed.kdf.algorithm).toBe('Argon2id')
    expect(packed.encryption.epochs).toHaveLength(1)
    expect(JSON.stringify(packed)).not.toContain(base64urlnopad.encode(secret))
    expect(
      await unpackBackupCredential({
        document: JSON.parse(JSON.stringify(packed)),
        exportPassphrase
      })
    ).toEqual(secret)
  })

  it('refuses a sealed document under the wrong export passphrase', async () => {
    expect(
      await errorName(() =>
        unpackBackupCredential({
          document: sealedPacked,
          exportPassphrase: 'wrong one'
        })
      )
    ).toBe('KeyUnwrapError')
  })

  it('refuses a sealed document with no export passphrase', async () => {
    expect(
      await errorName(() => unpackBackupCredential({ document: sealedPacked }))
    ).toBe('BundleInvalidError')
  })

  it('mints a fresh salt per bundle', async () => {
    const first = sealed(
      await packBackupCredential({ secret, exportPassphrase })
    )
    const second = sealed(
      await packBackupCredential({ secret, exportPassphrase })
    )
    expect(first.kdf.salt).not.toBe(second.kdf.salt)
    // 16 random bytes, base64url without padding.
    expect(first.kdf.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(first.kdf.salt).not.toBe('freewallet/keyring/unlock/argon2id/v1')
  })

  it('will not open under a substituted salt', async () => {
    const edited = {
      ...sealedPacked,
      kdf: { ...sealedPacked.kdf, salt: 'AAAAAAAAAAAAAAAAAAAAAA' }
    }
    expect(
      await errorName(() =>
        unpackBackupCredential({ document: edited, exportPassphrase })
      )
    ).toBe('KeyUnwrapError')
  })

  it('refuses a sealed document whose kdf is not the keyring parameter set', async () => {
    const packed = sealedPacked
    const tampered = [
      { ...packed.kdf, memory: 4_194_304 },
      { ...packed.kdf, passes: 1 },
      { ...packed.kdf, version: 1 },
      {
        algorithm: 'HKDF',
        hash: 'MD5',
        salt: packed.kdf.salt,
        info: 'x',
        version: 1
      },
      { ...packed.kdf, salt: '' },
      'not an object'
    ]
    for (const kdf of tampered) {
      expect(
        await errorName(() =>
          unpackBackupCredential({
            document: { ...packed, kdf },
            exportPassphrase
          })
        )
      ).toBe('BundleInvalidError')
    }
  })

  it('refuses a secret of the wrong length', async () => {
    const short = base64urlnopad.encode(new Uint8Array(31))
    const long = base64urlnopad.encode(new Uint8Array(33))
    for (const encoded of [short, long]) {
      expect(
        await errorName(() =>
          unpackBackupCredential({
            document: { form: 'plain', secret: encoded }
          })
        )
      ).toBe('BundleInvalidError')
    }
    await expect(
      packBackupCredential({ secret: new Uint8Array(16) })
    ).rejects.toThrow()
  })

  it('refuses a secret that is not base64url without padding', async () => {
    const padded = `${base64urlnopad.encode(secret)}=`
    // A standard-alphabet character where a base64url one belongs.
    const standard = `${base64urlnopad.encode(secret).slice(0, 42)}+`
    for (const encoded of [padded, 'not base64url!', standard]) {
      expect(
        await errorName(() =>
          unpackBackupCredential({
            document: { form: 'plain', secret: encoded }
          })
        )
      ).toBe('BundleInvalidError')
    }
  })

  it('refuses a malformed document', async () => {
    expect(
      await errorName(() => unpackBackupCredential({ document: null }))
    ).toBe('BundleInvalidError')
    expect(
      await errorName(() =>
        unpackBackupCredential({ document: { form: 'other' } })
      )
    ).toBe('BundleInvalidError')
    expect(
      await errorName(() =>
        unpackBackupCredential({ document: { form: 'plain' } })
      )
    ).toBe('BundleInvalidError')
  })
})
