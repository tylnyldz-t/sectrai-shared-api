import { LIVE_DISABLED, type LiveDisabled } from './safety.js'

export type GpuComputeTier = 'economy' | 'premium'
export type Unknown = 'UNKNOWN'

export type GpuResourceRequest = {
  computeTier: GpuComputeTier
  estimatedVramMiB: number | Unknown
  maximumRuntimeSeconds: number
  budgetEnvelopeRef: string
}

export type JncGpuResourceCard = {
  contract: 'jarvis-node-controller.gpu-resource-card.v1'
  controller: 'jarvis-node-controller'
  liveMode: LiveDisabled
  mode: 'CONTRACT_ONLY'
  transport: 'NONE'
  autostart: false
  dispatchState: 'NOT_DISPATCHED'
  executionAuthorization: 'NOT_AUTHORIZED'
  leaseState: 'NOT_ACQUIRED'
  resourceClass: 'GPU_HEAVY'
  separateOwnerApproval: 'REQUIRED'
  request: GpuResourceRequest | null
  stopConditions: readonly ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'NO_JNC_TRANSPORT', 'SEPARATE_OWNER_APPROVAL_REQUIRED']
}

export type JncBlenderPilotHandoff = {
  contract: 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1'
  adapterVersion: 'windows_blender_adapter/0.1.0-pilot'
  liveMode: LiveDisabled
  state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT'
  transport: 'NONE'
  executablePinning: 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED'
  invocation: 'ARGV_ONLY_NO_SHELL'
  scriptPolicy: 'PILOT_ALLOWLIST_REQUIRED'
  allowedActions: readonly ['create', 'export']
  gpu: { exclusiveGpu: false; deviceSelection: 'NOT_SUPPORTED'; compute: 'CPU_ONLY_PILOT' }
  artifactRequirements: readonly ['BLEND', 'GLB', 'ASSET_MANIFEST_JSON', 'VALIDATION_JSON']
  destination: 'BATCH_SCOPED_STAGING_ONLY'
  publication: 'OWNER_REVIEW_REQUIRED_NOT_PUBLISHED'
}

export type JncUnrealPilotHandoff = {
  contract: 'jarvis-node-controller.unreal-cli-pilot.v1'
  adapterVersion: 'unreal_cli_adapter/0.1.0-pilot'
  liveMode: LiveDisabled
  state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT'
  transport: 'NONE'
  executablePinning: 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED'
  invocation: 'ARGV_ONLY_NO_SHELL'
  project: 'REQUIRED'
  scriptPolicy: 'OWNER_ALLOWLIST_REQUIRED_BEFORE_SEPARATE_EXECUTION'
  renderer: 'NULL_RHI_NO_RENDER'
  timeout: 'BOUNDED_TIMEOUT_REQUIRED'
  destination: 'INCOMING_STAGING_ONLY'
  productionPromotion: 'DISABLED_OWNER_APPROVAL_REQUIRED'
}

/**
 * Pure data mapper for JNC pilot capabilities. It cannot resolve executables,
 * allocate GPU capacity, invoke a script, or contact a controller.
 */
export class ContractOnlyJncPilotMapper {
  createGpuResourceCard(request: GpuResourceRequest | undefined): JncGpuResourceCard {
    return {
      contract: 'jarvis-node-controller.gpu-resource-card.v1',
      controller: 'jarvis-node-controller',
      liveMode: LIVE_DISABLED,
      mode: 'CONTRACT_ONLY',
      transport: 'NONE',
      autostart: false,
      dispatchState: 'NOT_DISPATCHED',
      executionAuthorization: 'NOT_AUTHORIZED',
      leaseState: 'NOT_ACQUIRED',
      resourceClass: 'GPU_HEAVY',
      separateOwnerApproval: 'REQUIRED',
      request: request ?? null,
      stopConditions: ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'NO_JNC_TRANSPORT', 'SEPARATE_OWNER_APPROVAL_REQUIRED'],
    }
  }

  createBlenderHandoff(): JncBlenderPilotHandoff {
    return {
      contract: 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1',
      adapterVersion: 'windows_blender_adapter/0.1.0-pilot',
      liveMode: LIVE_DISABLED,
      state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT',
      transport: 'NONE',
      executablePinning: 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED',
      invocation: 'ARGV_ONLY_NO_SHELL',
      scriptPolicy: 'PILOT_ALLOWLIST_REQUIRED',
      allowedActions: ['create', 'export'],
      gpu: { exclusiveGpu: false, deviceSelection: 'NOT_SUPPORTED', compute: 'CPU_ONLY_PILOT' },
      artifactRequirements: ['BLEND', 'GLB', 'ASSET_MANIFEST_JSON', 'VALIDATION_JSON'],
      destination: 'BATCH_SCOPED_STAGING_ONLY',
      publication: 'OWNER_REVIEW_REQUIRED_NOT_PUBLISHED',
    }
  }

  createUnrealHandoff(): JncUnrealPilotHandoff {
    return {
      contract: 'jarvis-node-controller.unreal-cli-pilot.v1',
      adapterVersion: 'unreal_cli_adapter/0.1.0-pilot',
      liveMode: LIVE_DISABLED,
      state: 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT',
      transport: 'NONE',
      executablePinning: 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED',
      invocation: 'ARGV_ONLY_NO_SHELL',
      project: 'REQUIRED',
      scriptPolicy: 'OWNER_ALLOWLIST_REQUIRED_BEFORE_SEPARATE_EXECUTION',
      renderer: 'NULL_RHI_NO_RENDER',
      timeout: 'BOUNDED_TIMEOUT_REQUIRED',
      destination: 'INCOMING_STAGING_ONLY',
      productionPromotion: 'DISABLED_OWNER_APPROVAL_REQUIRED',
    }
  }
}
