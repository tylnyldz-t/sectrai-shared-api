/** Connector input is always treated as data, never as executable instructions. */
export type ConnectorKind = 'text-translation' | 'speech-translation' | 'document-analysis' | 'synthetic-camera' | 'external-data' | 'market' | 'media-generation'
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
  auditHash?: string
  actorId?: string
  runId?: string
  datasetId?: string
  liveStatus?: 'LIVE_DISABLED'
  synthetic?: true
  untrustedContent: IsolatedContent
}

/** Metadata only: translation text and audio bytes never enter artifact or audit storage. */
export type TranslationArtifactProposal = {
  kind: 'translated-text' | 'translated-speech'
  contentHash: string
  mediaType: 'text/plain' | 'audio/wav'
  source: 'synthetic-text-translation' | 'synthetic-speech-translation'
  synthetic: true
  approvalState: 'pending-checker-approval'
  autoPublish: false
  reviewPolicyVersion: 'gcl-translation-synthetic-v1'
  reviewExpiresAt: string
}

export type ConnectorResult<TData = unknown> = {
  data: TData
  provenance: ConnectorProvenance
  confidence: number
  artifact?: TranslationArtifactProposal
}

/** Redacted primitive-only metadata that binds a connector result to its success audit. */
export type ConnectorSuccessAuditDetail = Record<string, string | number | boolean | null>

type BaseConnectorRunContext = {
  product: string
  workspaceId: string
  ownerApproved: boolean
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
  now: () => Date
}

export type ConnectorRunContext = BaseConnectorRunContext & ({
  actor: string
  requestedBy?: never
  checkedBy?: never
  correlationId?: never
} | {
  actor: string
  requestedBy?: never
  checkedBy?: never
  correlationId: string
} | {
  actor?: never
  requestedBy: string
  checkedBy: string
  correlationId: string
})

export type ImageConnectorRunContext = BaseConnectorRunContext & {
  actor: string
  requestedBy?: never
  checkedBy?: never
  correlationId: string
}

export interface Connector<TInput = unknown, TData = unknown> {
  id: string
  kind: ConnectorKind
  authKind: ConnectorAuthKind
  quotaGroup?: string
  scopes: readonly string[]
  /**
   * Runs before audit/quota reservation so an unavailable adapter consumes
   * neither. A connector may return the canonical input snapshot that the
   * runner must later hand to `run`; `undefined` preserves the legacy
   * validate-only preflight shape.
   */
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<TInput | void> | TInput | void
  run(input: TInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TData>>
  validateResult?(result: ConnectorResult<TData>, ctx: ConnectorRunContext): ConnectorResult<TData>
  successAuditDetail?(result: ConnectorResult<TData>, ctx: ConnectorRunContext): Promise<ConnectorSuccessAuditDetail> | ConnectorSuccessAuditDetail
}

type BaseAuditEvent = {
  connectorId: string
  product: string
  workspaceId: string
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
  occurredAt: string
  detail: Record<string, unknown>
}

export type ConnectorAuditEvent = BaseAuditEvent & ({
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed' | 'translation.artifact.created' | 'translation.artifact.approved' | 'translation.artifact.rejected' | 'connector.document.owner_reviewed' | 'connector.market.owner_reviewed' | 'connector.artifact.candidates_issued' | 'connector.artifact.owner_liked' | 'connector.artifact.owner_rejected'
  actor: string
  requestedBy?: never
  checkedBy?: never
  correlationId?: string
} | {
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed' | 'connector.run.denied' | 'connector.camera.owner_reviewed'
  actor?: never
  requestedBy: string
  checkedBy: string
  correlationId: string
})

/** A locally checked append witness; it is not a durable lookup or signature. */
export type AuditAppendReceipt = Readonly<{ hash: string; previousHash?: string | null }>
export interface AuditLog {
  append(event: ConnectorAuditEvent): Promise<AuditAppendReceipt>
}

export interface ConnectorQuota {
  consume(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedItems'> & { connectorId: string; quotaGroup?: string; occurredAt: Date }): Promise<void>
}
