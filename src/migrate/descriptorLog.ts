/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Reading an encryption descriptor out of an archived governing history log.
 * Two logs feed the walk and both are read the same way: the account's user
 * key roster (`key-map/user-key.jsonl`, an ordinary Resource whose body is the
 * log's JSON Lines) and each Collection's own `meta/log` (archived as
 * `.collectionlog.<id>.json`, the server's stored record wrapping that body
 * beside its validator).
 *
 * The read is unverified on purpose: the walk checks no proof and no hash
 * chain, because a backup bundle carries no controller view to verify one
 * against. It parses the log's format, takes the head entry's `state`, and
 * refuses a state that is not an epoch configuration rather than handing it on
 * as a descriptor. A caller that needs the archived logs verified needs a
 * server-attested bundle first; that is a later build.
 */
import { parseResourceLog } from '@interop/vh-resource-log'
import { EPOCH_CONFIGURATION_STATE_TYPE } from '@interop/was-client/edv/core'
import type { CollectionEncryption } from '@interop/was-client'
import { CollectionLogUnreadableError } from '../errors.js'

/**
 * Reads a resource log's JSON Lines body down to the encryption descriptor its
 * head declares: the last entry's `state`, minus the schema identifier that
 * marks it as one.
 *
 * @param options {object}
 * @param options.body {string}   the log's JSON Lines text
 * @param options.label {string}   what a refusal calls the log
 * @returns {CollectionEncryption}
 */
export function descriptorFromLogBody({
  body,
  label
}: {
  body: string
  label: string
}): CollectionEncryption {
  let head: { state?: unknown } | undefined
  try {
    const entries = parseResourceLog(body)
    head = entries[entries.length - 1] as { state?: unknown } | undefined
  } catch (err) {
    throw new CollectionLogUnreadableError(
      `The ${label} is not a readable resource log.`,
      { cause: err }
    )
  }
  const state = head?.state
  if (state === null || typeof state !== 'object') {
    throw new CollectionLogUnreadableError(
      `The ${label} head entry carries no state object.`
    )
  }
  const { type, ...descriptor } = state as { type?: unknown }
  if (type !== EPOCH_CONFIGURATION_STATE_TYPE) {
    throw new CollectionLogUnreadableError(
      `The ${label} head state is of type "${String(type)}", not ` +
        `"${EPOCH_CONFIGURATION_STATE_TYPE}".`
    )
  }
  return descriptor as CollectionEncryption
}

/**
 * Reads the descriptor out of an archived Collection log file. The server
 * exports that file as its stored record -- the log body beside the validator
 * it was served under -- so the body is unwrapped before it is parsed.
 *
 * @param options {object}
 * @param options.bytes {Uint8Array}   the `.collectionlog.<id>.json` bytes
 * @param options.collectionId {string}
 * @returns {CollectionEncryption}
 */
export function descriptorFromCollectionLogFile({
  bytes,
  collectionId
}: {
  bytes: Uint8Array
  collectionId: string
}): CollectionEncryption {
  const label = `governing history log of collection "${collectionId}"`
  let record: unknown
  try {
    record = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    throw new CollectionLogUnreadableError(`The ${label} is not valid JSON.`, {
      cause: err
    })
  }
  const body =
    record !== null && typeof record === 'object'
      ? (record as { body?: unknown }).body
      : undefined
  if (typeof body !== 'string') {
    throw new CollectionLogUnreadableError(
      `The ${label} carries no string "body" member.`
    )
  }
  return descriptorFromLogBody({ body, label })
}
