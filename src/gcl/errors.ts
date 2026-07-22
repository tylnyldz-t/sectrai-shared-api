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

export class MakerCheckerError extends GclError {
  constructor(message = 'MAKER_CHECKER_SEPARATION_REQUIRED') { super(message, 403, 'maker_checker_separation_required') }
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

export class CameraConsentError extends GclError {
  constructor(message = 'CAMERA_CONSENT_REQUIRED') { super(message, 403, 'camera_consent_required') }
}

export class ConnectorInputError extends GclError {
  constructor(message = 'INVALID_CONNECTOR_INPUT') { super(message, 422, 'invalid_connector_input') }
}

/** A connector returned an unsafe or non-synthetic result envelope. */
export class ConnectorResultError extends GclError {
  constructor(message = 'INVALID_CONNECTOR_RESULT') { super(message, 502, 'invalid_connector_result') }
}

/** An audit collaborator did not return the one bounded hash receipt required to continue. */
export class AuditReceiptError extends GclError {
  constructor(message = 'INVALID_AUDIT_APPEND_RECEIPT') { super(message, 503, 'audit_log_unavailable') }
}

/** An audit event was shaped or mutable before it could cross into the log. */
export class AuditEventError extends GclError {
  constructor(message = 'INVALID_AUDIT_APPEND_EVENT') { super(message, 503, 'audit_log_unavailable') }
}
