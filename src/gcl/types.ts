export type ConnectorKind = 'external-data' | 'media-generation'
export type ConnectorAuthKind = 'owner-token' | 'oauth'

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
  actorId?: string
  runId?: string
  datasetId?: string
  auditHash?: string
  untrustedContent: IsolatedContent
}

export type ConnectorResult<TData = unknown> = {
  data: TData
  provenance: ConnectorProvenance
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
  /** Connectors in the same group share a daily reservation budget. */
  quotaGroup?: string
  /** Optional non-mutating configuration gate, executed before audit/quota reservation. */
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<void> | void
  run(input: TInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TData>>
}

export type ConnectorAuditEvent = {
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed'
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
  consume(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedItems'> & { connectorId: string; quotaGroup?: string; occurredAt: Date }): Promise<void>
}
