/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A vite-servable module the browser migration spec imports by its dev-server
 * URL: it builds a bundle whose one encrypted app collection holds a chunked
 * Resource, migrates it with a recovery code into a recording sink, and
 * returns what the sink saw. The fixture helpers are the node suite's own, so
 * the envelope and its chunks come from pws-client's chunked write.
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
  keyMapDir,
  logBody,
  mintGenerations,
  recipientFor,
  rosterDescriptor,
  sealBinaryResources,
  fixtureSpaceMetadataFile
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
  calls: Array<{ collectionId: string; method: string }>
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
      fixtureSpaceMetadataFile(),
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
  const calls: Array<{ collectionId: string; method: string }> = []
  /**
   * Builds the recorder for one standard collection method; the bundle
   * carries no standard collection, so none is expected to run.
   * @param method {string}   the sink method name the recorder stands in for
   * @returns {Function}
   */
  function recorder(method: string) {
    return async function accept({
      collectionId
    }: {
      collectionId: string
    }): Promise<SinkOutcome> {
      calls.push({ collectionId, method })
      return 'accepted'
    }
  }
  const report = await migrateBundle({
    bundle,
    secret: { recoveryCode: code },
    sink: {
      importCredential: recorder('importCredential'),
      importContact: recorder('importContact'),
      importContactRevision: recorder('importContactRevision'),
      importActivity: recorder('importActivity'),
      appCollections: {
        async ensureCollection({ collectionId }) {
          calls.push({ collectionId, method: 'ensureCollection' })
        },
        async importResource(options) {
          calls.push({
            collectionId: options.collectionId,
            method: 'importResource'
          })
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
    calls,
    report
  }
}
