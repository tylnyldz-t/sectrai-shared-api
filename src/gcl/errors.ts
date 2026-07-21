export class GclError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'GclError'
  }
}

export class ConnectorUnavailableError extends GclError {
  constructor(message = 'CONNECTOR_UNAVAILABLE') { super(message, 503, 'connector_unavailable') }
}

export class OwnerGateError extends GclError {
  constructor(message = 'OWNER_APPROVAL_REQUIRED') { super(message, 403, 'owner_approval_required') }
}

export class ScopeError extends GclError {
  constructor(message = 'CONNECTOR_SCOPE_DENIED') { super(message, 403, 'connector_scope_denied') }
}

export class CostCapError extends GclError {
  constructor(message = 'CONNECTOR_COST_CAP_EXCEEDED') { super(message, 422, 'connector_cost_cap_exceeded') }
}

export class ConnectorInputError extends GclError {
  constructor(message = 'CONNECTOR_INPUT_INVALID') { super(message, 422, 'connector_input_invalid') }
}

export class QuotaError extends GclError {
  constructor(message = 'CONNECTOR_QUOTA_EXCEEDED') { super(message, 429, 'connector_quota_exceeded') }
}

export class QueueError extends GclError {
  constructor(message = 'CONNECTOR_QUEUE_FULL') { super(message, 429, 'connector_queue_full') }
}

export class ConnectorUpstreamError extends GclError {
  constructor(message = 'CONNECTOR_UPSTREAM_ERROR') { super(message, 502, 'connector_upstream_error') }
}
