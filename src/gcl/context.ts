import { ConnectorContextError } from './errors.js'

/**
 * Every GCL entry point uses the same tenant envelope as the HTTP product
 * gate. Keeping this outside the web layer prevents programmatic callers
 * from reaching connector preflight, quota, or audit with an ambiguous scope.
 */
const PRODUCT_ID = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_ID = /^[a-zA-Z0-9:_-]{1,120}$/

export type GclTenantContext = {
  product: string
  workspaceId: string
}

export function validGclTenantContext(value: { product: unknown; workspaceId: unknown }): value is GclTenantContext {
  return typeof value.product === 'string'
    && PRODUCT_ID.test(value.product)
    && typeof value.workspaceId === 'string'
    && WORKSPACE_ID.test(value.workspaceId)
}

/** Reject rather than trim or broaden a product/workspace authority envelope. */
export function requireGclTenantContext(value: { product: unknown; workspaceId: unknown }): asserts value is GclTenantContext {
  if (!validGclTenantContext(value)) throw new ConnectorContextError()
}
