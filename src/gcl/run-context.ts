import { ConnectorInputError, CostCapError, OwnerGateError, ScopeError } from './errors.js'
import { isProxyValue } from './plan-integrity.js'
import type { ConnectorRunContext } from './types.js'

const PRODUCT_PATTERN = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CONTEXT_KEYS = ['product', 'workspaceId', 'actor', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems', 'now'] as const
const MAX_CONTEXT_SCOPES = 12

type DataRecord = Record<string, unknown>

/**
 * Reads only own enumerable data properties.  Connector context can be used
 * directly by an adapter in tests or future internal callers, so inherited
 * values and accessors are not trusted as governance state.
 */
function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (isProxyValue(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== keys.length || names.some((name) => !keys.includes(name))) return null
    const output: DataRecord = Object.create(null) as DataRecord
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function strictStringArray(value: unknown): string[] | null {
  try {
    if (isProxyValue(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    if (names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return null
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1 || lengthDescriptor.value > MAX_CONTEXT_SCOPES) return null
    const values: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') return null
      values.push(descriptor.value)
    }
    return values
  } catch {
    return null
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Revalidates and copies the governance boundary used by direct connector
 * calls.  The registry performs the same checks before audit/quota work; this
 * second boundary ensures an adapter cannot be bypassed by calling `run`
 * directly.  It never invokes `now` or performs I/O.
 */
export function validatedConnectorRunContext(value: unknown, connectorScopes: readonly string[]): ConnectorRunContext {
  const context = exactDataRecord(value, CONTEXT_KEYS)
  if (!context || typeof context.product !== 'string' || !PRODUCT_PATTERN.test(context.product) ||
    typeof context.workspaceId !== 'string' || !WORKSPACE_PATTERN.test(context.workspaceId) ||
    typeof context.actor !== 'string' || !ACTOR_PATTERN.test(context.actor) || typeof context.now !== 'function') {
    throw new ConnectorInputError('CONNECTOR_INVALID_CONTEXT')
  }
  if (context.ownerApproved !== true) throw new OwnerGateError()
  if (!positiveInteger(context.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
  if (!positiveInteger(context.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
  const scopes = strictStringArray(context.scopes)
  if (!scopes || scopes.length === 0 || new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !scope || scope.length > 120 || !connectorScopes.includes(scope))) {
    throw new ScopeError()
  }
  return Object.freeze({
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    ownerApproved: true,
    scopes: Object.freeze([...scopes]),
    costCapCents: context.costCapCents,
    requestedItems: context.requestedItems,
    now: context.now as () => Date,
  })
}
