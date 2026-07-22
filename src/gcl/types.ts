/** Connector input is always treated as data, never as executable instructions. */
export type ConnectorKind = 'text-translation' | 'speech-translation' | 'document-analysis'
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
  /**
   * Runs before audit/quota reservation so an unavailable adapter consumes
   * neither. A connector may return the canonical input snapshot that the
   * runner must later hand to `run`; `undefined` preserves the legacy
   * validate-only preflight shape.
   */
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<TInput | void> | TInput | void
  run(input: TInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TData>>
}

type BaseAuditEvent = {
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

export type ConnectorAuditEvent = BaseAuditEvent & {
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed' | 'translation.artifact.created' | 'translation.artifact.approved' | 'translation.artifact.rejected' | 'connector.document.owner_reviewed'
}
export interface AuditLog {
  append(event: ConnectorAuditEvent): Promise<{ hash: string }>
}

export interface ConnectorQuota {
  consume(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedItems'> & { connectorId: string; occurredAt: Date }): Promise<void>
}
