import { createHash } from 'node:crypto'
import { SyntheticReviewIntegrityError } from './errors.js'

export const SYNTHETIC_PLAN_INTEGRITY_CONTRACT = 'gcl.synthetic-plan-integrity.v1' as const

export type SyntheticPlanIntegrity = {
  contract: typeof SYNTHETIC_PLAN_INTEGRITY_CONTRACT
  payloadSha256: string
  content: 'DATA_ONLY_CANONICAL_JSON'
  mutation: 'DEEP_FROZEN'
}

function nonJsonValue(message = 'SYNTHETIC_PLAN_NON_JSON_VALUE'): never {
  throw new TypeError(message)
}

function arrayIndex(key: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key
}

/**
 * Canonicalise only data that can be represented without JavaScript-specific
 * behaviour. This deliberately rejects sparse arrays, accessors, symbol keys,
 * non-enumerable fields, and non-plain objects instead of silently assigning
 * them the same digest as a different JSON value.
 */
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SYNTHETIC_PLAN_NON_FINITE_NUMBER')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return nonJsonValue('SYNTHETIC_PLAN_NON_PLAIN_ARRAY')
    if (Object.getOwnPropertySymbols(value).length > 0) return nonJsonValue('SYNTHETIC_PLAN_SYMBOL_KEY')
    const names = Object.getOwnPropertyNames(value)
    if (names.some((name) => name !== 'length' && !arrayIndex(name))) return nonJsonValue('SYNTHETIC_PLAN_ARRAY_PROPERTY')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== value.length) return nonJsonValue('SYNTHETIC_PLAN_INVALID_ARRAY_LENGTH')
    if (seen.has(value)) throw new TypeError('SYNTHETIC_PLAN_CYCLIC_VALUE')
    seen.add(value)
    const output: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor) return nonJsonValue('SYNTHETIC_PLAN_SPARSE_ARRAY')
      if (!descriptor.enumerable || !('value' in descriptor)) return nonJsonValue('SYNTHETIC_PLAN_ARRAY_ACCESSOR')
      output.push(canonicalJson(descriptor.value, seen))
    }
    seen.delete(value)
    return `[${output.join(',')}]`
  }
  if (!value || typeof value !== 'object') return nonJsonValue()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return nonJsonValue('SYNTHETIC_PLAN_NON_PLAIN_OBJECT')
  if (Object.getOwnPropertySymbols(value).length > 0) return nonJsonValue('SYNTHETIC_PLAN_SYMBOL_KEY')
  if (seen.has(value)) throw new TypeError('SYNTHETIC_PLAN_CYCLIC_VALUE')
  seen.add(value)
  const entries: Array<[string, unknown]> = []
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable) return nonJsonValue('SYNTHETIC_PLAN_NON_ENUMERABLE_PROPERTY')
    if (!('value' in descriptor)) return nonJsonValue('SYNTHETIC_PLAN_ACCESSOR_PROPERTY')
    entries.push([key, descriptor.value])
  }
  const output = `{${entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, seen)}`).join(',')}}`
  seen.delete(value)
  return output
}

/** A stable digest for review correlation; it never evaluates or executes input. */
export function syntheticPlanSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** A non-throwing boundary check for data-only review payloads. */
export function isCanonicalJsonData(value: unknown): boolean {
  try {
    canonicalJson(value)
    return true
  } catch {
    return false
  }
}

export function createSyntheticPlanIntegrity(payload: unknown): SyntheticPlanIntegrity {
  return {
    contract: SYNTHETIC_PLAN_INTEGRITY_CONTRACT,
    payloadSha256: syntheticPlanSha256(payload),
    content: 'DATA_ONLY_CANONICAL_JSON',
    mutation: 'DEEP_FROZEN',
  }
}

export function isSyntheticPlanIntegrity(value: unknown): value is SyntheticPlanIntegrity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const candidate = value as Record<string, unknown>
  const allowed = ['contract', 'payloadSha256', 'content', 'mutation']
  return Object.keys(candidate).length === allowed.length && Object.keys(candidate).every((key) => allowed.includes(key)) &&
    candidate.contract === SYNTHETIC_PLAN_INTEGRITY_CONTRACT &&
    typeof candidate.payloadSha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.payloadSha256) &&
    candidate.content === 'DATA_ONLY_CANONICAL_JSON' && candidate.mutation === 'DEEP_FROZEN'
}

/**
 * Checks a review digest against the exact data-only payload. This is a local
 * consistency check; it is not a signature or execution authorization.
 */
export function verifiesSyntheticPlanIntegrity(integrity: unknown, payload: unknown): integrity is SyntheticPlanIntegrity {
  try {
    return isSyntheticPlanIntegrity(integrity) && integrity.payloadSha256 === syntheticPlanSha256(payload)
  } catch {
    return false
  }
}

/** Use this at a review boundary so a malformed snapshot fails closed. */
export function assertSyntheticPlanIntegrity(integrity: unknown, payload: unknown): asserts integrity is SyntheticPlanIntegrity {
  if (!verifiesSyntheticPlanIntegrity(integrity, payload)) throw new SyntheticReviewIntegrityError()
}

/**
 * Synthetic connector results are review snapshots. Freezing makes an
 * accidental in-memory change unable to turn a proposal into an execution or
 * publication instruction.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}
