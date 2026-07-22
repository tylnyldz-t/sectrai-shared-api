import { ConnectorResultError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { intrinsicJsonStringify } from './intrinsics.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'
import { CAMERA_CONNECTOR_ID, CAMERA_LIVE_STATUS, CAMERA_SCOPE, type CameraObservationResult, type SyntheticCameraConnectorConfig } from './camera-contract.js'
import { cameraExecutionContext, cameraObservationForReview, environmentPositiveInteger, fixtureFor, inputFrom, localCameraOccurredAt, positiveInteger, reviewPacketFor, validateCameraObservationForReview } from './camera-boundary.js'

export class SyntheticCameraConnector implements Connector<unknown, CameraObservationResult> {
  readonly id = CAMERA_CONNECTOR_ID
  readonly kind = 'synthetic-camera' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [CAMERA_SCOPE] as const
  readonly liveStatus = CAMERA_LIVE_STATUS

  constructor(private readonly config: SyntheticCameraConnectorConfig = {}) {}

  private configured(context: Pick<ReturnType<typeof cameraExecutionContext>, 'costCapCents' | 'requestedItems'>): void {
    if (this.config.liveEnabled) throw new ConnectorUnavailableError('CAMERA_LIVE_DISABLED')
    if (!this.config.syntheticEnabled) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_CONNECTOR_NOT_CONFIGURED')
    const maxCost = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCost || !maxItems) throw new ConnectorUnavailableError('CAMERA_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (context.costCapCents > maxCost) throw new CostCapError()
    if (context.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  }

  preflight(input: unknown, context: ConnectorRunContext): void {
    const execution = cameraExecutionContext(context)
    this.configured(execution)
    localCameraOccurredAt(execution.now, 'INVALID_CAMERA_PROVENANCE_CLOCK')
    fixtureFor(inputFrom(input))
  }

  validateResult(result: ConnectorResult<CameraObservationResult>, context: ConnectorRunContext): ConnectorResult<CameraObservationResult> {
    const data = validateCameraObservationForReview(result.data, context)
    let observation: CameraObservationResult['observation']
    try { observation = cameraObservationForReview(result.provenance.untrustedContent.value) } catch { throw new ConnectorResultError('INVALID_CAMERA_RESULT_DATA_PLANE') }
    if (result.confidence !== 0 || result.provenance.source !== `synthetic-camera-fixture:${data.cameraFixtureId}` || result.provenance.untrustedContent.source !== 'synthetic-camera-observation' || intrinsicJsonStringify(observation) !== intrinsicJsonStringify(data.observation)) throw new ConnectorResultError('INVALID_CAMERA_RESULT_DATA_PLANE')
    return {
      data, confidence: 0,
      provenance: {
        connectorId: CAMERA_CONNECTOR_ID, source: `synthetic-camera-fixture:${data.cameraFixtureId}`, retrievedAt: result.provenance.retrievedAt,
        liveStatus: CAMERA_LIVE_STATUS, synthetic: true,
        untrustedContent: { source: 'synthetic-camera-observation', value: observation, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
    }
  }

  async run(input: unknown, context: ConnectorRunContext): Promise<ConnectorResult<CameraObservationResult>> {
    const execution = cameraExecutionContext(context)
    this.configured(execution)
    const cameraInput = inputFrom(input)
    const fixture = fixtureFor(cameraInput)
    const base: Omit<CameraObservationResult, 'reviewPacket'> = {
      mode: 'SYNTHETIC' as const, liveStatus: CAMERA_LIVE_STATUS, cameraFixtureId: cameraInput.cameraFixtureId, purpose: cameraInput.purpose,
      observation: fixture.observation,
      privacy: { rawMediaAccepted: false, streamConnectionAttempted: false, deviceIdentifierRetained: false, biometricInference: 'NOT_PERFORMED' as const, identityResolution: 'NOT_PERFORMED' as const, resultPersistence: 'NOT_PERSISTED' as const },
      review: { state: 'OWNER_REVIEW_REQUIRED' as const, action: 'NOT_EXECUTED' as const, notification: 'NOT_SENT' as const, publication: 'NOT_PUBLISHED' as const },
    }
    const data: CameraObservationResult = { ...base, reviewPacket: reviewPacketFor(base, execution.product, execution.workspaceId) }
    return {
      data, confidence: 0,
      provenance: {
        connectorId: this.id, source: `synthetic-camera-fixture:${cameraInput.cameraFixtureId}`,
        retrievedAt: localCameraOccurredAt(execution.now, 'INVALID_CAMERA_PROVENANCE_CLOCK'), liveStatus: CAMERA_LIVE_STATUS, synthetic: true,
        untrustedContent: { source: 'synthetic-camera-observation', value: data.observation, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
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
