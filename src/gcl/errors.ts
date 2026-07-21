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

export class QuotaError extends GclError {
  constructor(message = 'CONNECTOR_QUOTA_EXCEEDED') { super(message, 429, 'connector_quota_exceeded') }
}

export class ConnectorInputError extends GclError {
  constructor(message = 'CONNECTOR_INPUT_INVALID') { super(message, 422, 'connector_input_invalid') }
}

export class ConsentError extends GclError {
  constructor(message = 'DOCUMENT_CONSENT_REQUIRED') { super(message, 403, 'document_consent_required') }
}

export class MakerCheckerError extends GclError {
  constructor(message = 'INDEPENDENT_OWNER_REVIEW_REQUIRED') { super(message, 403, 'independent_owner_review_required') }
}
