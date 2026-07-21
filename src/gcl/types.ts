export type ConnectorKind = 'speech-to-text' | 'text-to-speech'
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

/** Metadata only: voice bytes and transcript text are never put in audit records. */
export type VoiceArtifactProposal = {
  kind: 'transcript' | 'speech-audio'
  contentHash: string
  mediaType: 'text/plain' | 'audio/wav'
  source: 'synthetic-stt' | 'synthetic-tts'
  synthetic: true
  approvalState: 'pending-owner-approval'
  autoPublish: false
}

export type ConnectorResult<TData = unknown> = {
  data: TData
  provenance: ConnectorProvenance
  confidence: number
  artifact?: VoiceArtifactProposal
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
  /** Runs before audit/quota reservation so an unavailable adapter consumes neither. */
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<void> | void
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
  type: 'connector.run.requested' | 'connector.run.succeeded' | 'connector.run.failed' | 'voice.artifact.created' | 'voice.artifact.approved' | 'voice.artifact.rejected'
}

export interface AuditLog {
  append(event: ConnectorAuditEvent): Promise<{ hash: string }>
}

export interface ConnectorQuota {
  consume(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedItems'> & { connectorId: string; occurredAt: Date }): Promise<void>
}
