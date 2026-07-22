/**
 * One governed connector request may name at most this many approved scopes.
 * Keep this shared by the HTTP, direct-call, audit, and egress boundaries so
 * an internal caller cannot create review evidence the public route rejects.
 */
export const MAX_GOVERNANCE_SCOPE_COUNT = 12

/**
 * The public connector route and every direct governance boundary accept the
 * same bounded reservation envelope.  Keeping these limits here prevents an
 * internal caller from creating audit or review evidence that HTTP rejects.
 */
export const MAX_GOVERNANCE_COST_CAP_CENTS = 10_000_000
export const MAX_GOVERNANCE_REQUESTED_ITEMS = 100_000

/** Only the three built-in synthetic connectors are registered today. */
export const MAX_SYNTHETIC_CONNECTOR_REGISTRY_SIZE = 12

export function isGovernanceCostCapCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GOVERNANCE_COST_CAP_CENTS
}

export function isGovernanceRequestedItems(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GOVERNANCE_REQUESTED_ITEMS
}
