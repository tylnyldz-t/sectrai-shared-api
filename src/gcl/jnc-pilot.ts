import { ConnectorInputError } from './errors.js'
import { frozenCanonicalJsonCopy } from './plan-integrity.js'
import { LIVE_DISABLED, type LiveDisabled } from './safety.js'

export const JNC_MAXIMUM_GPU_RUNTIME_SECONDS = 5_400
export const JNC_MAXIMUM_GPU_RUNTIME_MINUTES = JNC_MAXIMUM_GPU_RUNTIME_SECONDS / 60

export type GpuResourceRequest = {
  computeTier: 'economy' | 'premium'
  estimatedVramMiB: number | 'UNKNOWN'
  maximumRuntimeSeconds: number
  budgetEnvelopeRef: string
}

export type JncGpuResourceCard = {
  contract: 'jarvis-node-controller.gpu-resource-card.v1'
  liveMode: LiveDisabled
  transport: 'NONE'
  dispatch: 'NOT_DISPATCHED'
  ownerApproval: 'REQUIRED'
  request: GpuResourceRequest | null
}

type JncPilotHandoff = {
  liveMode: LiveDisabled
  transport: 'NONE'
  state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT'
  ownerApproval: 'REQUIRED'
}

export type JncBlenderPilotHandoff = JncPilotHandoff & {
  contract: 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1'
}

export type JncUnrealPilotHandoff = JncPilotHandoff & {
  contract: 'jarvis-node-controller.unreal-cli-pilot.v1'
}

function gpuRequest(value: unknown): GpuResourceRequest {
  try {
    const request = frozenCanonicalJsonCopy<Record<string, unknown>>(value)
    if (Object.keys(request).length !== 4 || request.computeTier !== 'economy' && request.computeTier !== 'premium' ||
      request.estimatedVramMiB !== 'UNKNOWN' && (!Number.isSafeInteger(request.estimatedVramMiB) || (request.estimatedVramMiB as number) < 1) ||
      !Number.isSafeInteger(request.maximumRuntimeSeconds) || (request.maximumRuntimeSeconds as number) < 1 ||
      (request.maximumRuntimeSeconds as number) > JNC_MAXIMUM_GPU_RUNTIME_SECONDS || typeof request.budgetEnvelopeRef !== 'string' ||
      !request.budgetEnvelopeRef || request.budgetEnvelopeRef.trim() !== request.budgetEnvelopeRef || request.budgetEnvelopeRef.length > 160) {
      throw new ConnectorInputError('INVALID_JNC_GPU_RESOURCE_REQUEST')
    }
    return request as GpuResourceRequest
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_JNC_GPU_RESOURCE_REQUEST')
  }
}

/** Pure contract data; this mapper has no controller, process, or transport. */
export class ContractOnlyJncPilotMapper {
  createGpuResourceCard(request: GpuResourceRequest | undefined): JncGpuResourceCard {
    return Object.freeze({
      contract: 'jarvis-node-controller.gpu-resource-card.v1', liveMode: LIVE_DISABLED, transport: 'NONE', dispatch: 'NOT_DISPATCHED',
      ownerApproval: 'REQUIRED', request: request === undefined ? null : gpuRequest(request),
    })
  }

  createBlenderHandoff(): JncBlenderPilotHandoff {
    return Object.freeze({
      contract: 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1', liveMode: LIVE_DISABLED, transport: 'NONE',
      state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT', ownerApproval: 'REQUIRED',
    })
  }

  createUnrealHandoff(): JncUnrealPilotHandoff {
    return Object.freeze({
      contract: 'jarvis-node-controller.unreal-cli-pilot.v1', liveMode: LIVE_DISABLED, transport: 'NONE',
      state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT', ownerApproval: 'REQUIRED',
    })
  }
}
