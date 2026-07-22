import { intrinsicObjectFreeze } from './intrinsics.js'

export const CAMERA_CONNECTOR_ID = 'camera-observation'
export const CAMERA_LIVE_STATUS = 'LIVE_DISABLED' as const
export const CAMERA_SCOPE = 'camera:observe' as const
export const CAMERA_REVIEW_PACKET_VERSION = 'synthetic-camera-review-packet-v1' as const
export const CAMERA_REVIEW_RECEIPT_VERSION = 'synthetic-camera-review-receipt-v1' as const

export type AdosCameraControl = { id: `ADOS-${string}`; control: string; enforcement: string }

export const ADOS_10_CAMERA_CONTROLS: readonly AdosCameraControl[] = intrinsicObjectFreeze([
  { id: 'ADOS-01', control: 'PRODUCT_WORKSPACE_ISOLATION', enforcement: 'Review evidence is bound to one product and workspace.' },
  { id: 'ADOS-02', control: 'MINIMIZED_SYNTHETIC_FIXTURE', enforcement: 'Only allowlisted synthetic fixtures are resolved.' },
  { id: 'ADOS-03', control: 'DEFAULT_DENY_LIVE_DISABLED', enforcement: 'Synthetic enablement, limits, and disabled live mode are required.' },
  { id: 'ADOS-04', control: 'NO_MEDIA_OR_BIOMETRICS', enforcement: 'Media, device, identity, and biometric data are rejected.' },
  { id: 'ADOS-05', control: 'PURPOSE_BOUND_CONSENT', enforcement: 'Synthetic consent must match the fixture and purpose.' },
  { id: 'ADOS-06', control: 'OWNER_AND_MAKER_CHECKER', enforcement: 'Runs require owner approval and independent review.' },
  { id: 'ADOS-07', control: 'NO_EGRESS_OR_CREDENTIAL_INTERFACE', enforcement: 'No camera SDK, network client, stream URL, credential, or device surface exists.' },
  { id: 'ADOS-08', control: 'QUOTA_AND_HASH_AUDIT', enforcement: 'Governance is quota-limited and audit-hashed.' },
  { id: 'ADOS-09', control: 'OWNER_REVIEW_WITHOUT_HANDOFF', enforcement: 'Review records a decision only; no action or handoff is sent.' },
  { id: 'ADOS-10', control: 'NO_LAUNCH_OR_PRODUCTION_WRITE', enforcement: 'No production migration, main/prod write, live launch, or camera connection is available.' },
])

export type CameraPurpose = 'operational-safety' | 'site-security'
export type CameraConsent = {
  state: 'granted'
  receiptRef: string
  policyVersion: 'kvkk-synthetic-v1'
  sourceRights: 'synthetic-fixture'
}
export type CameraObservationInput = {
  synthetic: true
  cameraFixtureId: string
  purpose: CameraPurpose
  consent: CameraConsent
}
export type CameraOwnerReviewRequired = {
  state: 'OWNER_REVIEW_REQUIRED'
  action: 'NOT_EXECUTED'
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}
export type SyntheticCameraReviewPacket = {
  version: typeof CAMERA_REVIEW_PACKET_VERSION
  reviewId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  observationDigest: string
  integrityDigest: string
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}
export type CameraObservationResult = {
  mode: 'SYNTHETIC'
  liveStatus: typeof CAMERA_LIVE_STATUS
  cameraFixtureId: string
  purpose: CameraPurpose
  observation: {
    category: CameraPurpose
    severity: 'info' | 'warning' | 'critical'
    findingCode: string
    summary: string
  }
  privacy: {
    rawMediaAccepted: false
    streamConnectionAttempted: false
    deviceIdentifierRetained: false
    biometricInference: 'NOT_PERFORMED'
    identityResolution: 'NOT_PERFORMED'
    resultPersistence: 'NOT_PERSISTED'
  }
  review: CameraOwnerReviewRequired
  reviewPacket: SyntheticCameraReviewPacket
}
export type SyntheticCameraReviewReceipt = {
  version: typeof CAMERA_REVIEW_RECEIPT_VERSION
  receiptId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  reviewId: string
  observationDigest: string
  reviewPacketIntegrityDigest: string
  reviewerDigest: string
  decision: 'approved' | 'rejected'
  occurredAt: string
  mode: 'SYNTHETIC'
  liveStatus: typeof CAMERA_LIVE_STATUS
  disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
  auditHash: string
  integrityDigest: string
}
export type ReviewedCameraObservation = {
  reviewId: string
  decision: 'approved' | 'rejected'
  reviewPacketIntegrityDigest: string
  ownerReview: {
    state: 'APPROVED_FOR_SYNTHETIC_OBSERVATION_ONLY' | 'REJECTED_FOR_SYNTHETIC_OBSERVATION_ONLY'
    reviewer: string
    occurredAt: string
  }
  handoff: {
    state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED'
    rawMediaIncluded: false
    sent: false
    automaticAction: false
    notification: 'NOT_SENT'
    publication: 'NOT_PUBLISHED'
  }
  auditHash: string
  reviewReceipt: SyntheticCameraReviewReceipt
}
export type SyntheticCameraConnectorConfig = {
  syntheticEnabled?: boolean
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
}
