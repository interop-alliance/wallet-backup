/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A vite-servable module the browser migration spec imports by its dev-server
 * URL: it builds a bundle whose one encrypted app collection holds a chunked
 * Resource, migrates it with a recovery code into a recording sink, and
 * returns what the sink saw. The fixture helpers are the node suite's own, so
 * the envelope and its chunks come from was-client's chunked write.
 */
import {
  generateRecoveryCode,
  recoveryClientFromCode
} from '@interop/wallet-core/recovery/recoveryCode'
import { migrateBundle } from '../../src/index.js'
import type {
  AppCollectionResource,
  MigrationReport,
  SinkOutcome
} from '../../src/index.js'
import {
  buildBundle,
  chunkDirWith,
  collectionDescriptor,
  collectionDir,
  collectionLogFile,
  jsonFile,
  keyMapDir,
  logBody,
  mintGenerations,
  recipientFor,
  rosterDescriptor,
  sealBinaryResources,
  FIXTURE_SPACE_ID
} from '../fixtures/migration/bundle.js'

/**
 * Builds and migrates the one-chunked-Resource bundle.
 *
 * @returns {Promise<object>}   the plaintext written, what the sink received,
 *   the chunk count, and the report
 */
export async function migrateChunkedBundle(): Promise<{
  written: number[]
  received: { contentType: string; bytes: number[] } | undefined
  chunkCount: number
  report: MigrationReport
}> {
  const [generation] = await mintGenerations(1)
  const code = generateRecoveryCode()
  const client = await recoveryClientFromCode({ code })
  const roster = await rosterDescriptor({
    generations: [generation!],
    recipients: [recipientFor(client.agents.keyAgreementKey)]
  })
  const encryption = await collectionDescriptor({ openedBy: [[generation!]] })
  const written = new Uint8Array(100).map((_value, index) => (index * 7) % 251)
  const [sealed] = await sealBinaryResources({
    collectionId: 'photos',
    encryption,
    generation: generation!,
    resources: [{ data: written, contentType: 'image/png' }]
  })
  const bundle = await buildBundle({
    entries: [
      jsonFile({
        name: `.space.${FIXTURE_SPACE_ID}.json`,
        document: { id: FIXTURE_SPACE_ID, type: ['Space'] }
      }),
      keyMapDir(logBody(roster)),
      collectionDir({
        collectionId: 'photos',
        files: [
          collectionLogFile({
            collectionId: 'photos',
            body: logBody(encryption)
          }),
          sealed!.representation,
          chunkDirWith({ resourceId: sealed!.id, files: sealed!.chunks })
        ]
      })
    ]
  })

  const received: AppCollectionResource[] = []
  /**
   * Answers every standard collection call; the bundle carries none.
   * @returns {Promise<SinkOutcome>}
   */
  async function accept(): Promise<SinkOutcome> {
    return 'accepted'
  }
  const report = await migrateBundle({
    bundle,
    secret: { recoveryCode: code },
    sink: {
      importCredential: accept,
      importContact: accept,
      importContactRevision: accept,
      importActivity: accept,
      appCollections: {
        async ensureCollection() {},
        async importResource(options) {
          received.push(options)
          return 'accepted'
        }
      }
    }
  })
  const [resource] = received
  return {
    written: [...written],
    received:
      resource !== undefined && 'bytes' in resource
        ? { contentType: resource.contentType, bytes: [...resource.bytes] }
        : undefined,
    chunkCount: sealed!.chunks.length,
    report
  }
}
