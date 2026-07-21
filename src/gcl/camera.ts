import { CameraConsentError, ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const CAMERA_CONNECTOR_ID = 'camera-observation'
export const CAMERA_LIVE_STATUS = 'LIVE_DISABLED' as const
export const CAMERA_SCOPE = 'camera:observe' as const

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

export type CameraObservationResult = {
  mode: 'SYNTHETIC'
  liveStatus: typeof CAMERA_LIVE_STATUS
  cameraFixtureId: string
  purpose: CameraPurpose
  observation: {
    category: 'operational-safety' | 'site-security'
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
  review: { state: 'OWNER_REVIEW_REQUIRED'; action: 'NOT_EXECUTED'; notification: 'NOT_SENT'; publication: 'NOT_PUBLISHED' }
}

export type SyntheticCameraConnectorConfig = {
  syntheticEnabled?: boolean
  /** Any attempt to opt in to a live device closes this connector permanently. */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
}

type CameraFixture = {
  purpose: CameraPurpose
  consentReceiptRef: string
  observation: CameraObservationResult['observation']
}

const FIXTURES: Readonly<Record<string, CameraFixture>> = Object.freeze({
  'synthetic-loading-dock-001': {
    purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-001',
    observation: { category: 'operational-safety', severity: 'warning', findingCode: 'PPE_DRILL_INDICATOR', summary: 'Synthetic loading-dock safety drill indicator requires owner review.' },
  },
  'synthetic-perimeter-001': {
    purpose: 'site-security', consentReceiptRef: 'synthetic-consent-security-001',
    observation: { category: 'site-security', severity: 'info', findingCode: 'ACCESS_POINT_DRILL_INDICATOR', summary: 'Synthetic access-point drill indicator requires owner review.' },
  },
  'synthetic-fire-drill-001': {
    purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-002',
    observation: { category: 'operational-safety', severity: 'critical', findingCode: 'FIRE_DRILL_INDICATOR', summary: 'Synthetic fire-drill indicator requires owner review; no action is executed.' },
  },
})

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function inputFrom(value: unknown): CameraObservationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError('SYNTHETIC_CAMERA_INPUT_REQUIRED')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['synthetic', 'cameraFixtureId', 'purpose', 'consent'].includes(key))) throw new ConnectorInputError('SYNTHETIC_CAMERA_INPUT_REQUIRED')
  if (input.synthetic !== true || typeof input.cameraFixtureId !== 'string' || (input.purpose !== 'operational-safety' && input.purpose !== 'site-security')) {
    throw new ConnectorInputError('SYNTHETIC_CAMERA_INPUT_REQUIRED')
  }
  const consent = input.consent
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) throw new CameraConsentError()
  const assertion = consent as Record<string, unknown>
  if (Object.keys(assertion).some((key) => !['state', 'receiptRef', 'policyVersion', 'sourceRights'].includes(key))) throw new CameraConsentError()
  if (assertion.state !== 'granted' || typeof assertion.receiptRef !== 'string' || assertion.policyVersion !== 'kvkk-synthetic-v1' || assertion.sourceRights !== 'synthetic-fixture') {
    throw new CameraConsentError()
  }
  return {
    synthetic: true,
    cameraFixtureId: input.cameraFixtureId,
    purpose: input.purpose,
    consent: { state: 'granted', receiptRef: assertion.receiptRef, policyVersion: 'kvkk-synthetic-v1', sourceRights: 'synthetic-fixture' },
  }
}

function fixtureFor(input: CameraObservationInput): CameraFixture {
  const fixture = FIXTURES[input.cameraFixtureId]
  if (!fixture) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_FIXTURE_NOT_FOUND')
  if (fixture.purpose !== input.purpose || fixture.consentReceiptRef !== input.consent.receiptRef) throw new CameraConsentError('CAMERA_CONSENT_SCOPE_DENIED')
  return fixture
}

/**
 * Fixture-only camera contract. It has no camera SDK, HTTP client, device
 * address, snapshot, stream URL, credential, or raw-media input surface.
 */
export class SyntheticCameraConnector implements Connector<unknown, CameraObservationResult> {
  readonly id = CAMERA_CONNECTOR_ID
  readonly kind = 'synthetic-camera' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [CAMERA_SCOPE] as const
  readonly liveStatus = CAMERA_LIVE_STATUS

  constructor(private readonly config: SyntheticCameraConnectorConfig = {}) {}

  private configured(ctx: ConnectorRunContext): void {
    if (this.config.liveEnabled) throw new ConnectorUnavailableError('CAMERA_LIVE_DISABLED')
    if (!this.config.syntheticEnabled) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_CONNECTOR_NOT_CONFIGURED')
    const maxCostCapCents = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCostCapCents || !maxItems) throw new ConnectorUnavailableError('CAMERA_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
    if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  }

  preflight(input: unknown, ctx: ConnectorRunContext): void {
    this.configured(ctx)
    fixtureFor(inputFrom(input))
  }

  async run(input: unknown, ctx: ConnectorRunContext): Promise<ConnectorResult<CameraObservationResult>> {
    this.configured(ctx)
    const cameraInput = inputFrom(input)
    const fixture = fixtureFor(cameraInput)
    const data: CameraObservationResult = {
      mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, cameraFixtureId: cameraInput.cameraFixtureId, purpose: cameraInput.purpose,
      observation: fixture.observation,
      privacy: {
        rawMediaAccepted: false, streamConnectionAttempted: false, deviceIdentifierRetained: false,
        biometricInference: 'NOT_PERFORMED', identityResolution: 'NOT_PERFORMED', resultPersistence: 'NOT_PERSISTED',
      },
      review: { state: 'OWNER_REVIEW_REQUIRED', action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' },
    }
    return {
      data,
      provenance: {
        connectorId: this.id,
        source: `synthetic-camera-fixture:${cameraInput.cameraFixtureId}`,
        retrievedAt: ctx.now().toISOString(), liveStatus: CAMERA_LIVE_STATUS, synthetic: true,
        untrustedContent: {
          source: 'synthetic-camera-observation', value: data.observation,
          handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

export function cameraConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticCameraConnector {
  return new SyntheticCameraConnector({
    syntheticEnabled: environment.GCL_CAMERA_SYNTHETIC_ENABLED === 'true',
    liveEnabled: environment.GCL_CAMERA_LIVE_ENABLED === 'true',
    maxCostCapCents: environmentPositiveInteger(environment.GCL_CAMERA_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_CAMERA_MAX_ITEMS),
  })
}
