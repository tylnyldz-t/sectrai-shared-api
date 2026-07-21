import { createHash } from 'node:crypto'
import { SyntheticReviewIntegrityError } from './errors.js'

export const SYNTHETIC_PLAN_INTEGRITY_CONTRACT = 'gcl.synthetic-plan-integrity.v1' as const

export type SyntheticPlanIntegrity = {
  contract: typeof SYNTHETIC_PLAN_INTEGRITY_CONTRACT
  payloadSha256: string
  content: 'DATA_ONLY_CANONICAL_JSON'
  mutation: 'DEEP_FROZEN'
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SYNTHETIC_PLAN_NON_FINITE_NUMBER')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item, seen)).join(',')}]`
  if (!value || typeof value !== 'object') throw new TypeError('SYNTHETIC_PLAN_NON_JSON_VALUE')
  if (seen.has(value)) throw new TypeError('SYNTHETIC_PLAN_CYCLIC_VALUE')
  seen.add(value)
  const record = value as Record<string, unknown>
  const output = `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`
  seen.delete(value)
  return output
}

/** A stable digest for review correlation; it never evaluates or executes input. */
export function syntheticPlanSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function createSyntheticPlanIntegrity(payload: unknown): SyntheticPlanIntegrity {
  return {
    contract: SYNTHETIC_PLAN_INTEGRITY_CONTRACT,
    payloadSha256: syntheticPlanSha256(payload),
    content: 'DATA_ONLY_CANONICAL_JSON',
    mutation: 'DEEP_FROZEN',
  }
}

function integrityShape(value: unknown): value is SyntheticPlanIntegrity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
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
export function verifiesSyntheticPlanIntegrity(integrity: unknown, payload: unknown): boolean {
  return integrityShape(integrity) && integrity.payloadSha256 === syntheticPlanSha256(payload)
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
