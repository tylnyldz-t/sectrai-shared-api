/**
 * This is the sole accepted mode for every GM5/GM6 adapter.  There is no
 * LIVE_ENABLED alternative in this package.
 */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const

export type LiveDisabled = typeof LIVE_DISABLED
