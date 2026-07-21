import { SyntheticResultIntegrityError } from './errors.js'
import { deepFreeze, isCanonicalJsonData, syntheticPlanSha256 } from './plan-integrity.js'
import { verifiesSyntheticReviewSnapshot } from './review-snapshot.js'
import { LIVE_DISABLED } from './safety.js'
import type { ConnectorResult, IsolatedContent } from './types.js'

type DataRecord = Record<string, unknown>

const RESULT_KEYS = ['data', 'provenance', 'confidence'] as const
const PROVENANCE_KEYS = ['connectorId', 'source', 'retrievedAt', 'runId', 'untrustedContent'] as const
const UNTRUSTED_CONTENT_KEYS = ['source', 'value', 'handling', 'instructionPolicy'] as const
const THREE_D_DATA_KEYS = ['connectorKind', 'liveMode', 'integrity', 'reviewReceipt', 'reviewSnapshot', 'artifact', 'gpuResourceCard', 'blenderPilotHandoff'] as const
const GAME_DATA_BASE_KEYS = ['adapter', 'liveMode', 'integrity', 'reviewReceipt', 'reviewSnapshot', 'execution', 'buildId', 'tier', 'engine', 'target', 'pipeline', 'buildOutput', 'publication'] as const
const GAME_DATA_PREMIUM_KEYS = [...GAME_DATA_BASE_KEYS, 'gpuResourceCard', 'jncPilotHandoff'] as const

/**
 * Copies only own enumerable data descriptors. Getter-backed, inherited,
 * symbol, class, or hidden result fields are not a safe egress contract.
 */
function ownDataRecord(value: unknown): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const output = Object.create(null) as DataRecord
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[name] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function exactKeys(value: DataRecord, expected: readonly string[]): boolean {
  const names = Object.keys(value)
  return names.length === expected.length && names.every((name) => expected.includes(name))
}

function exactOptionalKeys(value: DataRecord, required: readonly string[], allowed: readonly string[]): boolean {
  const names = Object.keys(value)
  return required.every((name) => Object.hasOwn(value, name)) && names.every((name) => allowed.includes(name))
}

function sameCanonicalData(left: unknown, right: unknown): boolean {
  try {
    return syntheticPlanSha256(left) === syntheticPlanSha256(right)
  } catch {
    return false
  }
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const date = new Date(value)
    return !Number.isNaN(date.getTime()) && date.toISOString() === value
  } catch {
    return false
  }
}

/** Canonical JSON alone is insufficient: every nested result value must be frozen too. */
function deeplyFrozenCanonicalData(value: unknown, seen = new WeakSet<object>()): boolean {
  try {
    if (!isCanonicalJsonData(value)) return false
    if (!value || typeof value !== 'object') return true
    if (seen.has(value) || !Object.isFrozen(value)) return false
    seen.add(value)
    for (const name of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && name === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !('value' in descriptor) || !deeplyFrozenCanonicalData(descriptor.value, seen)) return false
    }
    seen.delete(value)
    return true
  } catch {
    return false
  }
}

function snapshotAndCoreData(data: DataRecord, connectorId: string): DataRecord | null {
  if (data.liveMode !== LIVE_DISABLED) return null
  if (!verifiesSyntheticReviewSnapshot(data.reviewSnapshot)) return null
  const snapshot = ownDataRecord(data.reviewSnapshot)
  if (!snapshot || !sameCanonicalData(data.integrity, snapshot.integrity) || !sameCanonicalData(data.reviewReceipt, snapshot.reviewReceipt)) return null
  const payload = ownDataRecord(snapshot.payload)
  if (!payload || payload.connectorId !== connectorId) return null
  return payload
}

function threeDResultMatchesSnapshot(data: DataRecord, connectorId: string): boolean {
  if (!exactKeys(data, THREE_D_DATA_KEYS) || data.connectorKind !== connectorId) return false
  const payload = snapshotAndCoreData(data, connectorId)
  return Boolean(payload &&
    sameCanonicalData(data.artifact, payload.artifact) &&
    sameCanonicalData(data.gpuResourceCard, payload.gpuResourceCard) &&
    sameCanonicalData(data.blenderPilotHandoff, payload.blenderPilotHandoff))
}

function gameResultMatchesSnapshot(data: DataRecord, connectorId: string): boolean {
  if (!exactOptionalKeys(data, GAME_DATA_BASE_KEYS, GAME_DATA_PREMIUM_KEYS) ||
    data.adapter !== 'SYNTHETIC' || data.execution !== 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED') return false
  const payload = snapshotAndCoreData(data, connectorId)
  const input = payload ? ownDataRecord(payload.input) : null
  if (!payload || !input ||
    !sameCanonicalData(data.buildId, payload.buildId) ||
    !sameCanonicalData(data.pipeline, payload.pipeline) ||
    !sameCanonicalData(data.buildOutput, payload.buildOutput) ||
    !sameCanonicalData(data.publication, payload.publication) ||
    data.tier !== input.tier || data.engine !== input.engine || data.target !== input.target) return false

  const premium = input.tier === 'premium'
  if (premium !== Object.hasOwn(data, 'gpuResourceCard') || premium !== Object.hasOwn(data, 'jncPilotHandoff')) return false
  return !premium || (sameCanonicalData(data.gpuResourceCard, payload.gpuResourceCard) && sameCanonicalData(data.jncPilotHandoff, payload.jncPilotHandoff))
}

function syntheticDataMatchesSnapshot(data: unknown, connectorId: string): data is DataRecord {
  if (!deeplyFrozenCanonicalData(data)) return false
  const record = ownDataRecord(data)
  if (!record) return false
  if (connectorId === 'text-to-3d' || connectorId === 'image-text-to-3d') return threeDResultMatchesSnapshot(record, connectorId)
  if (connectorId === 'game-engine') return gameResultMatchesSnapshot(record, connectorId)
  return false
}

function safeUntrustedContent(value: unknown): IsolatedContent | null {
  const record = ownDataRecord(value)
  if (!record || !exactKeys(record, UNTRUSTED_CONTENT_KEYS) ||
    typeof record.source !== 'string' || !/^[a-z0-9:-]{1,160}$/.test(record.source) || !isCanonicalJsonData(record.value) ||
    record.handling !== 'data-only' || record.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS') return null
  return {
    source: record.source,
    value: record.value,
    handling: 'data-only',
    instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
  }
}

function safeProvenance(value: unknown, connectorId: string): ConnectorResult['provenance'] | null {
  const record = ownDataRecord(value)
  if (!record || !exactOptionalKeys(record, ['connectorId', 'source', 'retrievedAt', 'untrustedContent'], PROVENANCE_KEYS) ||
    record.connectorId !== connectorId || typeof record.source !== 'string' || !/^synthetic(?:[-:][a-z0-9]+)*$/.test(record.source) ||
    !validIsoTimestamp(record.retrievedAt) || (Object.hasOwn(record, 'runId') && (typeof record.runId !== 'string' || !/^[a-z0-9-]{1,160}$/.test(record.runId)))) return null
  const untrustedContent = safeUntrustedContent(record.untrustedContent)
  if (!untrustedContent) return null
  return {
    connectorId,
    source: record.source,
    retrievedAt: record.retrievedAt,
    ...(Object.hasOwn(record, 'runId') ? { runId: record.runId as string } : {}),
    untrustedContent,
  }
}

/**
 * The last GM5/GM6 boundary before API serialization. It admits only the
 * known synthetic result shapes, checks each displayed plan field against the
 * signed-by-digest review snapshot, and returns a fresh frozen envelope.
 * This has no I/O and cannot turn a plan into an execution path.
 */
export function validatedSyntheticConnectorResult(value: unknown, connectorId: string): ConnectorResult {
  const result = ownDataRecord(value)
  if (!result || !exactKeys(result, RESULT_KEYS) || result.confidence !== 0 || !syntheticDataMatchesSnapshot(result.data, connectorId)) {
    throw new SyntheticResultIntegrityError()
  }
  const provenance = safeProvenance(result.provenance, connectorId)
  if (!provenance) throw new SyntheticResultIntegrityError()
  return deepFreeze({ data: result.data, provenance, confidence: 0 })
}
