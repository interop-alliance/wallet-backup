# Wallet Backup _(@interop/wallet-backup)_

[![Node.js CI](https://github.com/interop-alliance/wallet-backup/workflows/CI/badge.svg)](https://github.com/interop-alliance/wallet-backup/actions?query=workflow%3A%22CI%22)
[![NPM Version](https://img.shields.io/npm/v/@interop/wallet-backup.svg)](https://npm.im/@interop/wallet-backup)

> Backup bundle codec and content-migration walk for portable wallets.

Reads and writes the backup bundle a portable wallet exports: the outer tar with
its manifest and packed recovery code, and the per-Space export archives it
carries. Isomorphic (browser, Node.js, React Native) and offline -- bytes in,
bytes out, no HTTP.

The per-Space export archive itself is read and written by
[`@interop/space-archive`](https://npm.im/@interop/space-archive); this package
carries it verbatim inside a bundle and does not re-export its codec. See that
package's README for `packSpaceArchive`, `readSpaceArchive`, and the file-name
dialect.

## Table of Contents

- [Background](#background)
- [Security](#security)
- [Install](#install)
- [Usage](#usage)
- [Contribute](#contribute)
- [License](#license)

## Background

TBD

## Security

TBD

## Install

- Node.js 24+ is recommended.

### PNPM

To install via PNPM:

```
pnpm install @interop/wallet-backup @interop/wallet-core @interop/was-client
```

`@interop/wallet-core` and `@interop/was-client` are peer dependencies. The host
wallet already depends on both, and this package uses the host's copy, so the
bundle codec and the walk share the wallet's own constants, KDF parameters and
ciphers.

### Development

To install locally (for development):

```
git clone https://github.com/interop-alliance/wallet-backup.git
cd wallet-backup
pnpm install
```

## Usage

### Migrating a backup bundle into a new account

`migrateBundle` reads a bundle's account Space archive, recovers the old user
key from one old secret, decrypts each standard collection's rows, and pushes
them one at a time at a sink you supply. It issues no HTTP request and holds no
collection in memory; each sink call is awaited before the next row is
decrypted.

```js
import { migrateBundle } from '@interop/wallet-backup'

const sink = {
  async importContact({ collectionId, resourceId, row }) {
    return store.hasContact(row.contactId) ? 'skipped' : store.addContact(row)
  },
  async importContactRevision({ row }) {
    return store.addContactRevision(row)
  },
  async importCredential({ row }) {
    return store.addCredential(row)
  },
  async importActivity({ row }) {
    return store.addActivity(row)
  }
}

const report = await migrateBundle({
  bundle: bytes, // the bundle's tar bytes, or a stream of them
  secret: { passphrase: 'the old account passphrase' },
  sink,
  signal: controller.signal,
  onProgress({ collectionId, index, outcome }) {
    ui.show(`${collectionId} #${index}: ${outcome}`)
  }
})

report.collections['private-credentials']
// { accepted: 12, skipped: 3, conflicting: 0, failed: 0, unopenable: 0 }
report.notMigrated // { 'app-connections': 2 }
report.manifest // the bundle manifest minus its `contents`
```

Each import function returns `accepted`, `skipped`, `conflicting` or `failed`. A
method that throws counts as a failed row and the walk carries on; ten
consecutive failures end that collection (its report entry names the cause under
`stoppedBy`) and the walk moves to the next. A throw named `QuotaExceededError`
ends the whole walk, and `report.stoppedAt` names where.

The secret is one of `{ passphrase }`, `{ recoveryCode }`, or
`{ packedCode: { exportPassphrase } }` -- the last reads the bundle's own
`recovery-code.json`, unsealing it when the bundle was exported under an export
passphrase. A secret that is a recipient of nothing in the archived user key
roster is refused with `BundleRecipientMissingError` before any row is written.

### Writing and reading a bundle

```js
import {
  packRecoveryCode,
  readBundle,
  writeBundle,
  BUNDLE_ROLE
} from '@interop/wallet-backup'

const pack = await writeBundle({
  meta: { created, createdBy: { controller, client } },
  spaces: [{ spaceId, role: BUNDLE_ROLE.accountSpaceArchive, archive }],
  recoveryCode: await packRecoveryCode({ code, exportPassphrase })
})

const bundle = await readBundle(bytes)
for await (const space of bundle.spaces) {
  // one Space archive at a time
}
// Walking `spaces` to its end, or breaking out of the loop, releases the
// source. A caller that never walks it calls `bundle.close()` instead.
```

## Contribute

PRs accepted. See [CONTRIBUTING.md](CONTRIBUTING.md) for editor setup (Prettier,
ESLint, and EditorConfig) and how it maps to CI.

If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance.
