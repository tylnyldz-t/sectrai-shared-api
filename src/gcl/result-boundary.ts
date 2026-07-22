import { SyntheticResultIntegrityError } from './errors.js'
import { deepFreeze, frozenCanonicalJsonCopy } from './plan-integrity.js'
import { LIVE_DISABLED } from './safety.js'
import type { ConnectorResult } from './types.js'

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

/**
 * Keep the public result boundary small: it accepts only detached, frozen,
 * no-confidence plans with the permanent live-mode kill switch intact.
 */
export function validatedSyntheticConnectorResult<TData = unknown>(value: unknown, connectorId: string): ConnectorResult<TData> {
  try {
    const result = frozenCanonicalJsonCopy<ConnectorResult<TData>>(value)
    if (!record(result) || Object.keys(result).length !== 3 || result.confidence !== 0 || !record(result.data) || result.data.liveMode !== LIVE_DISABLED) {
      throw new SyntheticResultIntegrityError()
    }
    const provenance = result.provenance
    if (!record(provenance) || provenance.connectorId !== connectorId || typeof provenance.source !== 'string' || !provenance.source ||
      !validTimestamp(provenance.retrievedAt) || !record(provenance.untrustedContent) || provenance.untrustedContent.handling !== 'data-only' ||
      provenance.untrustedContent.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS') {
      throw new SyntheticResultIntegrityError()
    }
    return deepFreeze(result)
  } catch (error) {
    if (error instanceof SyntheticResultIntegrityError) throw error
    throw new SyntheticResultIntegrityError()
  }
}
