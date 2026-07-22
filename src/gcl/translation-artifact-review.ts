import { createHash } from 'node:crypto'
import type { TranslationArtifactProposal } from './types.js'

/**
 * This is the complete metadata-only envelope a checker authorizes. It is
 * deliberately shared by artifact storage and audit validation so a
 * syntactically valid, but invented, review digest cannot enter the chain.
 */
export type TranslationArtifactReviewDigestInput = {
  connectorId: string
  kind: TranslationArtifactProposal['kind']
  contentHash: string
  mediaType: TranslationArtifactProposal['mediaType']
  source: TranslationArtifactProposal['source']
  synthetic: true
  autoPublish: false
  reviewPolicyVersion: TranslationArtifactProposal['reviewPolicyVersion']
  reviewExpiresAt: string
  runAuditHash: string
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Exact, content-free binding that must be identical in storage and audit. */
export function translationArtifactReviewDigest(input: TranslationArtifactReviewDigestInput): string {
  return digest({
    connectorId: input.connectorId,
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: input.synthetic,
    autoPublish: input.autoPublish,
    reviewPolicyVersion: input.reviewPolicyVersion,
    reviewExpiresAt: input.reviewExpiresAt,
    runAuditHash: input.runAuditHash,
  })
}
