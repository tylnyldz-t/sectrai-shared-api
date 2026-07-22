import { LIVE_DISABLED, type LiveDisabled } from './safety.js'
import { ConnectorInputError } from './errors.js'
import { deepFreeze, isProxyValue } from './plan-integrity.js'

/**
 * The contract-only GPU card must remain compatible with the bounded JNC
 * pilot envelope. It is a data validation ceiling, never a lease duration or
 * an instruction to start a GPU process.
 */
export const JNC_MAXIMUM_GPU_RUNTIME_SECONDS = 5_400
export const JNC_MAXIMUM_GPU_RUNTIME_MINUTES = JNC_MAXIMUM_GPU_RUNTIME_SECONDS / 60

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

const GPU_RESOURCE_REQUEST_KEYS = ['computeTier', 'estimatedVramMiB', 'maximumRuntimeSeconds', 'budgetEnvelopeRef'] as const

function invalidGpuResourceRequest(): never {
  throw new ConnectorInputError('INVALID_JNC_GPU_RESOURCE_REQUEST')
}

/**
 * Copy only the exact, own data fields used by a contract card. This protects
 * the mapper when it is called directly, not only through the GM5/GM6 input
 * validators that normally precede it.
 */
function normalizedGpuResourceRequest(value: unknown): GpuResourceRequest {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidGpuResourceRequest()
    if (isProxyValue(value)) return invalidGpuResourceRequest()
    const prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
      return invalidGpuResourceRequest()
    }
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== GPU_RESOURCE_REQUEST_KEYS.length || names.some((name) => !(GPU_RESOURCE_REQUEST_KEYS as readonly string[]).includes(name))) {
      return invalidGpuResourceRequest()
    }
    const record = Object.create(null) as Record<string, unknown>
    for (const name of GPU_RESOURCE_REQUEST_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidGpuResourceRequest()
      record[name] = descriptor.value
    }
    if (record.computeTier !== 'economy' && record.computeTier !== 'premium') return invalidGpuResourceRequest()
    if (record.estimatedVramMiB !== 'UNKNOWN' &&
      (typeof record.estimatedVramMiB !== 'number' || !Number.isSafeInteger(record.estimatedVramMiB) || record.estimatedVramMiB <= 0)) {
      return invalidGpuResourceRequest()
    }
    if (typeof record.maximumRuntimeSeconds !== 'number' || !Number.isSafeInteger(record.maximumRuntimeSeconds) ||
      record.maximumRuntimeSeconds < 1 || record.maximumRuntimeSeconds > JNC_MAXIMUM_GPU_RUNTIME_SECONDS) {
      return invalidGpuResourceRequest()
    }
    if (typeof record.budgetEnvelopeRef !== 'string' || !record.budgetEnvelopeRef ||
      record.budgetEnvelopeRef.trim() !== record.budgetEnvelopeRef || record.budgetEnvelopeRef.length > 160) {
      return invalidGpuResourceRequest()
    }
    return {
      computeTier: record.computeTier,
      estimatedVramMiB: record.estimatedVramMiB,
      maximumRuntimeSeconds: record.maximumRuntimeSeconds,
      budgetEnvelopeRef: record.budgetEnvelopeRef,
    }
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    return invalidGpuResourceRequest()
  }
}

/**
 * Pure data mapper for JNC pilot capabilities. It cannot resolve executables,
 * allocate GPU capacity, invoke a script, or contact a controller.
 */
export class ContractOnlyJncPilotMapper {
  createGpuResourceCard(request: GpuResourceRequest | undefined): JncGpuResourceCard {
    return deepFreeze<JncGpuResourceCard>({
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
      request: request === undefined ? null : normalizedGpuResourceRequest(request),
      stopConditions: ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'NO_JNC_TRANSPORT', 'SEPARATE_OWNER_APPROVAL_REQUIRED'],
    })
  }

  createBlenderHandoff(): JncBlenderPilotHandoff {
    return deepFreeze<JncBlenderPilotHandoff>({
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
    })
  }

  createUnrealHandoff(): JncUnrealPilotHandoff {
    return deepFreeze<JncUnrealPilotHandoff>({
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
    })
  }
}
