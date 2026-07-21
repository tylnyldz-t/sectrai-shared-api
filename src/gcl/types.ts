/** Connector input is always treated as data, never as executable instructions. */
export type ConnectorKind = 'document-analysis'
export type ConnectorAuthKind = 'owner-token'

export type IsolatedContent = {
  source: string
  value: unknown
  handling: 'data-only'
  instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS'
}

export type ConnectorProvenance = {
  connectorId: string
  source: string
  retrievedAt: string
  auditHash?: string
  untrustedContent: IsolatedContent
}

export type ConnectorResult<TData = unknown> = {
  data: TData
  provenance: ConnectorProvenance
  /** Synthetic proposals make no OCR accuracy claim. */
  confidence: number
}

export type ConnectorRunContext = {
  product: string
  workspaceId: string
  actor: string
  ownerApproved: boolean
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
  now: () => Date
}

export interface Connector<TInput = unknown, TData = unknown> {
  id: string
  kind: ConnectorKind
  authKind: ConnectorAuthKind
  scopes: readonly string[]
  /** Must not mutate state or contact a provider. Runs before audit/quota reservation. */
  preflight?(input: TInput, context: ConnectorRunContext): Promise<void> | void
  run(input: TInput, context: ConnectorRunContext): Promise<ConnectorResult<TData>>
}

export type ConnectorAuditEvent = {
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed' | 'connector.document.owner_reviewed'
  connectorId: string
  product: string
  workspaceId: string
  actor: string
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
  occurredAt: string
  detail: Record<string, unknown>
}

export interface AuditLog {
  append(event: ConnectorAuditEvent): Promise<{ hash: string }>
}

export interface ConnectorQuota {
  consume(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedItems'> & { connectorId: string; occurredAt: Date }): Promise<void>
}
