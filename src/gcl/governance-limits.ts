/**
 * One governed connector request may name at most this many approved scopes.
 * Keep this shared by the HTTP, direct-call, audit, and egress boundaries so
 * an internal caller cannot create review evidence the public route rejects.
 */
export const MAX_GOVERNANCE_SCOPE_COUNT = 12
