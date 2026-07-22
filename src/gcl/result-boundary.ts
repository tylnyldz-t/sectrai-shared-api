import { SyntheticResultIntegrityError } from './errors.js'
import { JNC_MAXIMUM_GPU_RUNTIME_SECONDS } from './jnc-pilot.js'
import { deepFreeze, isCanonicalJsonData, isProxyValue, syntheticPlanSha256 } from './plan-integrity.js'
import { verifiesSyntheticReviewSnapshot } from './review-snapshot.js'
import { LIVE_DISABLED } from './safety.js'
import type { ConnectorResult, ConnectorRunContext, IsolatedContent } from './types.js'

type DataRecord = Record<string, unknown>

const RESULT_KEYS = ['data', 'provenance', 'confidence'] as const
const PROVENANCE_KEYS = ['connectorId', 'source', 'retrievedAt', 'runId', 'untrustedContent'] as const
const UNTRUSTED_CONTENT_KEYS = ['source', 'value', 'handling', 'instructionPolicy'] as const
const THREE_D_DATA_KEYS = ['connectorKind', 'liveMode', 'integrity', 'reviewReceipt', 'reviewSnapshot', 'artifact', 'gpuResourceCard', 'blenderPilotHandoff'] as const
const GAME_DATA_BASE_KEYS = ['adapter', 'liveMode', 'integrity', 'reviewReceipt', 'reviewSnapshot', 'execution', 'buildId', 'tier', 'engine', 'target', 'pipeline', 'buildOutput', 'publication'] as const
const GAME_DATA_PREMIUM_KEYS = [...GAME_DATA_BASE_KEYS, 'gpuResourceCard', 'jncPilotHandoff'] as const
const GPU_CARD_STOP_CONDITIONS = ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'NO_JNC_TRANSPORT', 'SEPARATE_OWNER_APPROVAL_REQUIRED'] as const
const BLENDER_ARTIFACT_REQUIREMENTS = ['BLEND', 'GLB', 'ASSET_MANIFEST_JSON', 'VALIDATION_JSON'] as const
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PRODUCT_PATTERN = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

export type SyntheticResultReviewBinding = {
  scope: { product: string; workspaceId: string }
  actor: string
  governance: { scopes: readonly string[]; costCapCents: number; requestedItems: number }
  /** Exact locally captured governance instant; never a caller-supplied label. */
  retrievedAt: string
}

/**
 * Copies only own enumerable data descriptors. Getter-backed, inherited,
 * symbol, class, or hidden result fields are not a safe egress contract.
 */
function ownDataRecord(value: unknown): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (isProxyValue(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const output = Object.create(null) as DataRecord
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[name] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function exactKeys(value: DataRecord, expected: readonly string[]): boolean {
  const names = Object.keys(value)
  return names.length === expected.length && names.every((name) => expected.includes(name))
}

function exactOptionalKeys(value: DataRecord, required: readonly string[], allowed: readonly string[]): boolean {
  const names = Object.keys(value)
  return required.every((name) => Object.hasOwn(value, name)) && names.every((name) => allowed.includes(name))
}

function strictStringArray(value: unknown): string[] | null {
  try {
    if (isProxyValue(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1 ||
      names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return null
    const output: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string' ||
        !descriptor.value || descriptor.value.length > 120) return null
      output.push(descriptor.value)
    }
    return new Set(output).size === output.length ? output : null
  } catch {
    return null
  }
}

/**
 * Captures the governed scope and reservation units that a displayed plan is
 * allowed to represent. This is data only; it neither reserves quota nor
 * authorises any execution, transport, artifact write, or publication.
 */
export function syntheticResultReviewBinding(
  context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'actor' | 'scopes' | 'costCapCents' | 'requestedItems'>,
  retrievedAt: string,
): SyntheticResultReviewBinding {
  const source = ownDataRecord(context)
  const scopes = source ? strictStringArray(source.scopes) : null
  const binding = source && scopes && validIsoTimestamp(retrievedAt) ? normalizedReviewBinding({
    scope: { product: source.product, workspaceId: source.workspaceId },
    actor: source.actor,
    governance: {
      scopes: [...scopes].sort(),
      costCapCents: source.costCapCents,
      requestedItems: source.requestedItems,
    },
    retrievedAt,
  }) : null
  if (!binding) throw new SyntheticResultIntegrityError('SYNTHETIC_RESULT_REVIEW_BINDING_INVALID')
  return deepFreeze(binding)
}

function normalizedReviewBinding(value: unknown): SyntheticResultReviewBinding | null {
  const binding = ownDataRecord(value)
  if (!binding || !exactKeys(binding, ['scope', 'actor', 'governance', 'retrievedAt'])) return null
  const scope = ownDataRecord(binding.scope)
  const governance = ownDataRecord(binding.governance)
  if (!scope || !exactKeys(scope, ['product', 'workspaceId']) || typeof scope.product !== 'string' || !PRODUCT_PATTERN.test(scope.product) ||
    typeof scope.workspaceId !== 'string' || !WORKSPACE_PATTERN.test(scope.workspaceId) ||
    typeof binding.actor !== 'string' || !ACTOR_PATTERN.test(binding.actor) ||
    !governance || !exactKeys(governance, ['scopes', 'costCapCents', 'requestedItems']) ||
    typeof governance.costCapCents !== 'number' || !Number.isSafeInteger(governance.costCapCents) || governance.costCapCents < 1 ||
    typeof governance.requestedItems !== 'number' || !Number.isSafeInteger(governance.requestedItems) || governance.requestedItems < 1 ||
    !validIsoTimestamp(binding.retrievedAt)) return null
  const scopes = strictStringArray(governance.scopes)
  return scopes === null ? null : {
    scope: { product: scope.product, workspaceId: scope.workspaceId },
    actor: binding.actor,
    governance: { scopes, costCapCents: governance.costCapCents, requestedItems: governance.requestedItems },
    retrievedAt: binding.retrievedAt,
  }
}

function sameCanonicalData(left: unknown, right: unknown): boolean {
  try {
    return syntheticPlanSha256(left) === syntheticPlanSha256(right)
  } catch {
    return false
  }
}

/**
 * Rebuild the one permitted plan input from the frozen request snapshot. The
 * review digest binds the raw request, while this normal form binds the plan's
 * displayed input after the adapters' documented trim/default rules. Keeping
 * this policy at the final boundary means a connector cannot retain a request
 * digest while substituting another otherwise-valid, re-hashed plan.
 */
function boundedSubmissionString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= maximumLength ? value.trim() : null
}

function allowedSubmissionKeys(value: DataRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((name) => allowed.includes(name))
}

function normalizedGpuSubmission(value: unknown): DataRecord | null {
  const request = ownDataRecord(value)
  if (!request || !exactKeys(request, ['computeTier', 'estimatedVramMiB', 'maximumRuntimeSeconds', 'budgetEnvelopeRef']) ||
    (request.computeTier !== 'economy' && request.computeTier !== 'premium') ||
    (request.estimatedVramMiB !== 'UNKNOWN' && (typeof request.estimatedVramMiB !== 'number' || !Number.isSafeInteger(request.estimatedVramMiB) || request.estimatedVramMiB <= 0)) ||
    typeof request.maximumRuntimeSeconds !== 'number' || !Number.isSafeInteger(request.maximumRuntimeSeconds) ||
    request.maximumRuntimeSeconds < 1 || request.maximumRuntimeSeconds > JNC_MAXIMUM_GPU_RUNTIME_SECONDS) return null
  const budgetEnvelopeRef = boundedSubmissionString(request.budgetEnvelopeRef, 160)
  return budgetEnvelopeRef === null ? null : {
    computeTier: request.computeTier,
    estimatedVramMiB: request.estimatedVramMiB,
    maximumRuntimeSeconds: request.maximumRuntimeSeconds,
    budgetEnvelopeRef,
  }
}

function normalizedThreeDSubmission(connectorId: string, value: unknown): DataRecord | null {
  const input = ownDataRecord(value)
  const imageConnector = connectorId === 'image-text-to-3d'
  const allowed = imageConnector
    ? ['prompt', 'image', 'style', 'outputFormat', 'gpuResourceRequest']
    : ['prompt', 'style', 'outputFormat', 'gpuResourceRequest']
  if (!input || !allowedSubmissionKeys(input, allowed)) return null
  const prompt = boundedSubmissionString(input.prompt, 4_000)
  if (prompt === null || (input.outputFormat !== undefined && input.outputFormat !== 'glb' && input.outputFormat !== 'obj')) return null
  const style = input.style === undefined ? undefined : boundedSubmissionString(input.style, 160)
  const gpuResourceRequest = input.gpuResourceRequest === undefined ? undefined : normalizedGpuSubmission(input.gpuResourceRequest)
  if (style === null || gpuResourceRequest === null) return null
  const normalized: DataRecord = {
    prompt,
    outputFormat: input.outputFormat === undefined ? 'glb' : input.outputFormat,
    ...(style === undefined ? {} : { style }),
    ...(gpuResourceRequest === undefined ? {} : { gpuResourceRequest }),
  }
  if (!imageConnector) return normalized
  const image = ownDataRecord(input.image)
  if (!image || !exactKeys(image, ['assetId', 'sha256', 'mediaType']) ||
    (image.mediaType !== 'image/jpeg' && image.mediaType !== 'image/png' && image.mediaType !== 'image/webp')) return null
  const assetId = boundedSubmissionString(image.assetId, 160)
  const sha256 = boundedSubmissionString(image.sha256, 64)
  if (assetId === null || sha256 === null || !SHA256_PATTERN.test(sha256)) return null
  return { ...normalized, image: { assetId, sha256: sha256.toLowerCase(), mediaType: image.mediaType } }
}

function normalizedGameSubmission(value: unknown): DataRecord | null {
  const input = ownDataRecord(value)
  if (!input || !allowedSubmissionKeys(input, ['tier', 'engine', 'projectId', 'brief', 'target', 'gpuMinutes']) ||
    (input.tier !== 'economic' && input.tier !== 'premium') ||
    (input.engine !== 'godot' && input.engine !== 'unreal' && input.engine !== 'blender') ||
    typeof input.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.projectId) ||
    (input.target !== 'desktop' && input.target !== 'mobile' && input.target !== 'web')) return null
  const brief = boundedSubmissionString(input.brief, 4_000)
  if (brief === null) return null
  if (input.tier === 'economic') {
    return input.engine === 'godot' && input.gpuMinutes === undefined
      ? { tier: input.tier, engine: input.engine, projectId: input.projectId, brief, target: input.target }
      : null
  }
  if (input.engine === 'godot' || typeof input.gpuMinutes !== 'number' || !Number.isSafeInteger(input.gpuMinutes) || input.gpuMinutes < 1) return null
  return { tier: input.tier, engine: input.engine, projectId: input.projectId, brief, target: input.target, gpuMinutes: input.gpuMinutes }
}

type SubmissionBinding = { sha256: string; normalizedInput: DataRecord }

function submissionBinding(connectorId: string, submittedInput: unknown): SubmissionBinding | null {
  try {
    const normalizedInput = connectorId === 'text-to-3d' || connectorId === 'image-text-to-3d'
      ? normalizedThreeDSubmission(connectorId, submittedInput)
      : connectorId === 'game-engine'
        ? normalizedGameSubmission(submittedInput)
        : null
    return normalizedInput ? { sha256: syntheticPlanSha256(submittedInput), normalizedInput } : null
  } catch {
    return null
  }
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const date = new Date(value)
    return !Number.isNaN(date.getTime()) && date.toISOString() === value
  } catch {
    return false
  }
}

/** Canonical JSON alone is insufficient: every nested result value must be frozen too. */
function deeplyFrozenCanonicalData(value: unknown, seen = new WeakSet<object>()): boolean {
  try {
    if (!isCanonicalJsonData(value)) return false
    if (!value || typeof value !== 'object') return true
    if (seen.has(value) || !Object.isFrozen(value)) return false
    seen.add(value)
    for (const name of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && name === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !('value' in descriptor) || !deeplyFrozenCanonicalData(descriptor.value, seen)) return false
    }
    seen.delete(value)
    return true
  } catch {
    return false
  }
}

function snapshotAndCoreData(data: DataRecord, connectorId: string, submission: SubmissionBinding, binding: SyntheticResultReviewBinding): DataRecord | null {
  if (data.liveMode !== LIVE_DISABLED) return null
  if (!verifiesSyntheticReviewSnapshot(data.reviewSnapshot)) return null
  const snapshot = ownDataRecord(data.reviewSnapshot)
  if (!snapshot || !sameCanonicalData(data.integrity, snapshot.integrity) || !sameCanonicalData(data.reviewReceipt, snapshot.reviewReceipt)) return null
  const payload = ownDataRecord(snapshot.payload)
  if (!payload || payload.connectorId !== connectorId || payload.submittedInputSha256 !== submission.sha256 ||
    !sameCanonicalData(payload.scope, binding.scope) || payload.actor !== binding.actor || !sameCanonicalData(payload.governance, binding.governance) ||
    !sameCanonicalData(payload.input, submission.normalizedInput)) return null
  return payload
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
}

function validGpuResourceCard(value: unknown): boolean {
  const card = ownDataRecord(value)
  if (!card || !exactKeys(card, [
    'contract', 'controller', 'liveMode', 'mode', 'transport', 'autostart', 'dispatchState', 'executionAuthorization',
    'leaseState', 'resourceClass', 'separateOwnerApproval', 'request', 'stopConditions',
  ])) return false
  if (card.contract !== 'jarvis-node-controller.gpu-resource-card.v1' || card.controller !== 'jarvis-node-controller' ||
    card.liveMode !== LIVE_DISABLED || card.mode !== 'CONTRACT_ONLY' || card.transport !== 'NONE' || card.autostart !== false ||
    card.dispatchState !== 'NOT_DISPATCHED' || card.executionAuthorization !== 'NOT_AUTHORIZED' || card.leaseState !== 'NOT_ACQUIRED' ||
    card.resourceClass !== 'GPU_HEAVY' || card.separateOwnerApproval !== 'REQUIRED' || !exactStringArray(card.stopConditions, GPU_CARD_STOP_CONDITIONS)) return false
  if (card.request === null) return true
  const request = ownDataRecord(card.request)
  return Boolean(request && exactKeys(request, ['computeTier', 'estimatedVramMiB', 'maximumRuntimeSeconds', 'budgetEnvelopeRef']) &&
    (request.computeTier === 'economy' || request.computeTier === 'premium') &&
    (request.estimatedVramMiB === 'UNKNOWN' || typeof request.estimatedVramMiB === 'number' && Number.isSafeInteger(request.estimatedVramMiB) && request.estimatedVramMiB > 0) &&
    typeof request.maximumRuntimeSeconds === 'number' && Number.isSafeInteger(request.maximumRuntimeSeconds) && request.maximumRuntimeSeconds > 0 && request.maximumRuntimeSeconds <= JNC_MAXIMUM_GPU_RUNTIME_SECONDS &&
    typeof request.budgetEnvelopeRef === 'string' && request.budgetEnvelopeRef.trim() === request.budgetEnvelopeRef && request.budgetEnvelopeRef.length > 0 && request.budgetEnvelopeRef.length <= 160)
}

function validBlenderPilotHandoff(value: unknown): boolean {
  const handoff = ownDataRecord(value)
  return Boolean(handoff && exactKeys(handoff, [
    'contract', 'adapterVersion', 'liveMode', 'state', 'transport', 'executablePinning', 'invocation', 'scriptPolicy',
    'allowedActions', 'gpu', 'artifactRequirements', 'destination', 'publication',
  ]) && handoff.contract === 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1' &&
    handoff.adapterVersion === 'windows_blender_adapter/0.1.0-pilot' && handoff.liveMode === LIVE_DISABLED &&
    handoff.state === 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT' && handoff.transport === 'NONE' &&
    handoff.executablePinning === 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED' && handoff.invocation === 'ARGV_ONLY_NO_SHELL' &&
    handoff.scriptPolicy === 'PILOT_ALLOWLIST_REQUIRED' && exactStringArray(handoff.allowedActions, ['create', 'export']) &&
    exactStringArray(handoff.artifactRequirements, BLENDER_ARTIFACT_REQUIREMENTS) && handoff.destination === 'BATCH_SCOPED_STAGING_ONLY' &&
    handoff.publication === 'OWNER_REVIEW_REQUIRED_NOT_PUBLISHED' && sameCanonicalData(handoff.gpu, {
      exclusiveGpu: false, deviceSelection: 'NOT_SUPPORTED', compute: 'CPU_ONLY_PILOT',
    }))
}

function validUnrealPilotHandoff(value: unknown): boolean {
  const handoff = ownDataRecord(value)
  return Boolean(handoff && exactKeys(handoff, [
    'contract', 'adapterVersion', 'liveMode', 'state', 'transport', 'executablePinning', 'invocation', 'project', 'scriptPolicy',
    'renderer', 'timeout', 'destination', 'productionPromotion',
  ]) && handoff.contract === 'jarvis-node-controller.unreal-cli-pilot.v1' && handoff.adapterVersion === 'unreal_cli_adapter/0.1.0-pilot' &&
    handoff.liveMode === LIVE_DISABLED && handoff.state === 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT' && handoff.transport === 'NONE' &&
    handoff.executablePinning === 'REQUIRED_AT_SEPARATE_EXECUTION_NOT_ATTEMPTED' && handoff.invocation === 'ARGV_ONLY_NO_SHELL' &&
    handoff.project === 'REQUIRED' && handoff.scriptPolicy === 'OWNER_ALLOWLIST_REQUIRED_BEFORE_SEPARATE_EXECUTION' &&
    handoff.renderer === 'NULL_RHI_NO_RENDER' && handoff.timeout === 'BOUNDED_TIMEOUT_REQUIRED' &&
    handoff.destination === 'INCOMING_STAGING_ONLY' && handoff.productionPromotion === 'DISABLED_OWNER_APPROVAL_REQUIRED')
}

function validThreeDArtifact(value: unknown, connectorId: string, payload: DataRecord, binding: SyntheticResultReviewBinding): boolean {
  const artifact = ownDataRecord(value)
  const scope = ownDataRecord(payload.scope)
  const input = ownDataRecord(payload.input)
  const expectedArtifactId = scope && exactKeys(scope, ['product', 'workspaceId']) && typeof scope.product === 'string' && typeof scope.workspaceId === 'string'
    ? `synthetic-3d-${connectorId}-${syntheticPlanSha256({
      connectorKind: connectorId,
      input: payload.input,
      product: scope.product,
      workspaceId: scope.workspaceId,
      actor: binding.actor,
      scopes: [...binding.governance.scopes].sort(),
      costCapCents: binding.governance.costCapCents,
      requestedItems: binding.governance.requestedItems,
    }).slice(0, 24)}`
    : null
  return Boolean(artifact && input && (input.outputFormat === 'glb' || input.outputFormat === 'obj') &&
    exactKeys(artifact, ['artifactId', 'syntheticUri', 'generation', 'outputFormat', 'lifecycle', 'reviewState', 'publicationState']) &&
    typeof artifact.artifactId === 'string' && artifact.artifactId === expectedArtifactId &&
    artifact.syntheticUri === `synthetic://gcl-3d/${connectorId}/${artifact.artifactId}` && artifact.generation === 'SYNTHETIC_PROPOSAL_ONLY' &&
    artifact.outputFormat === input.outputFormat && artifact.lifecycle === 'GENERATED_CANDIDATE_NOT_A_FILE' &&
    artifact.reviewState === 'OWNER_REVIEW_REQUIRED' && artifact.publicationState === 'NOT_PUBLISHED')
}

/**
 * The optional GPU request is submitted as review data.  Its card must be the
 * exact normalized request from that plan (or null when none was submitted),
 * so a valid-looking card cannot swap in another budget reference, tier, or
 * runtime envelope after preflight.
 */
function threeDGpuCardMatchesSnapshotInput(value: unknown, payload: DataRecord): boolean {
  if (!validGpuResourceCard(value)) return false
  const card = ownDataRecord(value)
  const input = ownDataRecord(payload.input)
  if (!card || !input) return false
  const expectedRequest = Object.hasOwn(input, 'gpuResourceRequest') ? input.gpuResourceRequest : null
  return sameCanonicalData(card.request, expectedRequest)
}

function threeDResultMatchesSnapshot(data: DataRecord, connectorId: string, submission: SubmissionBinding, binding: SyntheticResultReviewBinding): boolean {
  if (!exactKeys(data, THREE_D_DATA_KEYS) || data.connectorKind !== connectorId) return false
  const payload = snapshotAndCoreData(data, connectorId, submission, binding)
  return Boolean(payload &&
    sameCanonicalData(data.artifact, payload.artifact) &&
    sameCanonicalData(data.gpuResourceCard, payload.gpuResourceCard) &&
    sameCanonicalData(data.blenderPilotHandoff, payload.blenderPilotHandoff) &&
    validThreeDArtifact(data.artifact, connectorId, payload, binding) &&
    threeDGpuCardMatchesSnapshotInput(data.gpuResourceCard, payload) && validBlenderPilotHandoff(data.blenderPilotHandoff))
}

type GameInputPolicy = { tier: 'economic' | 'premium'; engine: 'godot' | 'unreal' | 'blender'; target: 'desktop' | 'mobile' | 'web'; gpuMinutes?: number }

function gameInputPolicy(value: unknown): GameInputPolicy | null {
  const input = ownDataRecord(value)
  if (!input || !exactOptionalKeys(input, ['tier', 'engine', 'projectId', 'brief', 'target'], ['tier', 'engine', 'projectId', 'brief', 'target', 'gpuMinutes']) ||
    (input.tier !== 'economic' && input.tier !== 'premium') || (input.engine !== 'godot' && input.engine !== 'unreal' && input.engine !== 'blender') ||
    typeof input.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.projectId) || typeof input.brief !== 'string' || !input.brief.trim() || input.brief.trim() !== input.brief || input.brief.length > 4_000 ||
    (input.target !== 'desktop' && input.target !== 'mobile' && input.target !== 'web')) return null
  if (input.tier === 'economic' && (input.engine !== 'godot' || Object.hasOwn(input, 'gpuMinutes'))) return null
  if (input.tier === 'premium' && (input.engine === 'godot' || typeof input.gpuMinutes !== 'number' || !Number.isSafeInteger(input.gpuMinutes) || input.gpuMinutes <= 0)) return null
  return { tier: input.tier, engine: input.engine, target: input.target, ...(input.tier === 'premium' ? { gpuMinutes: input.gpuMinutes as number } : {}) }
}

function validGamePipeline(value: unknown, input: GameInputPolicy): boolean {
  const expected = input.tier === 'economic'
    ? [
      { id: 'project-scaffold', state: 'PLANNED_NOT_EXECUTED' },
      { id: 'godot-headless-import', state: 'PLANNED_NOT_EXECUTED', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--editor', '--quit'] },
      { id: 'godot-headless-export', state: 'PLANNED_NOT_EXECUTED', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--export-release', '<preset>', '<output-path>'] },
      { id: 'owner-build-evidence-review', state: 'PLANNED_NOT_EXECUTED' },
    ]
    : [
      { id: 'jarvis-gpu-contract-card', state: 'PLANNED_NOT_EXECUTED' },
      { id: `${input.engine}-pilot-handoff`, state: 'PLANNED_NOT_EXECUTED' },
      { id: 'owner-build-evidence-review', state: 'PLANNED_NOT_EXECUTED' },
    ]
  return sameCanonicalData(value, expected)
}

function gameResultMatchesSnapshot(data: DataRecord, connectorId: string, submission: SubmissionBinding, binding: SyntheticResultReviewBinding): boolean {
  if (!exactOptionalKeys(data, GAME_DATA_BASE_KEYS, GAME_DATA_PREMIUM_KEYS) ||
    data.adapter !== 'SYNTHETIC' || data.execution !== 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED') return false
  const payload = snapshotAndCoreData(data, connectorId, submission, binding)
  const input = payload ? gameInputPolicy(payload.input) : null
  if (!payload || !input || typeof data.buildId !== 'string' || !/^synthetic-game-[a-f0-9]{20}$/.test(data.buildId) ||
    !sameCanonicalData(data.buildId, payload.buildId) ||
    !sameCanonicalData(data.pipeline, payload.pipeline) ||
    !sameCanonicalData(data.buildOutput, payload.buildOutput) ||
    !sameCanonicalData(data.publication, payload.publication) ||
    data.tier !== input.tier || data.engine !== input.engine || data.target !== input.target ||
    !validGamePipeline(data.pipeline, input) || !sameCanonicalData(data.buildOutput, { state: 'OWNER_APPROVAL_REQUIRED', evidence: 'SYNTHETIC_BUILD_PLAN_ONLY' }) ||
    !sameCanonicalData(data.publication, { automatic: false, state: 'DISABLED_NOT_IMPLEMENTED' }) ||
    data.buildId !== `synthetic-game-${syntheticPlanSha256({
      input: payload.input,
      product: binding.scope.product,
      workspaceId: binding.scope.workspaceId,
      actor: binding.actor,
      scopes: [...binding.governance.scopes].sort(),
      costCapCents: binding.governance.costCapCents,
      requestedItems: binding.governance.requestedItems,
    }).slice(0, 20)}`) return false

  const premium = input.tier === 'premium'
  if (premium !== Object.hasOwn(data, 'gpuResourceCard') || premium !== Object.hasOwn(data, 'jncPilotHandoff')) return false
  if (!premium) return true
  const resourceCard = ownDataRecord(data.gpuResourceCard)
  const expectedRequest = {
    computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: input.gpuMinutes as number * 60,
    budgetEnvelopeRef: `gcl-game-engine:${data.buildId}`,
  }
  return sameCanonicalData(data.gpuResourceCard, payload.gpuResourceCard) && sameCanonicalData(data.jncPilotHandoff, payload.jncPilotHandoff) &&
    validGpuResourceCard(data.gpuResourceCard) && sameCanonicalData(resourceCard?.request, expectedRequest) &&
    (input.engine === 'unreal' ? validUnrealPilotHandoff(data.jncPilotHandoff) : validBlenderPilotHandoff(data.jncPilotHandoff))
}

function syntheticDataMatchesSnapshot(data: unknown, connectorId: string, submittedInput: unknown, reviewBinding: unknown): data is DataRecord {
  const submission = submissionBinding(connectorId, submittedInput)
  const binding = normalizedReviewBinding(reviewBinding)
  if (!submission || !binding) return false
  if (!deeplyFrozenCanonicalData(data)) return false
  const record = ownDataRecord(data)
  if (!record) return false
  if (connectorId === 'text-to-3d' || connectorId === 'image-text-to-3d') return threeDResultMatchesSnapshot(record, connectorId, submission, binding)
  if (connectorId === 'game-engine') return gameResultMatchesSnapshot(record, connectorId, submission, binding)
  return false
}

function safeUntrustedContent(value: unknown): IsolatedContent | null {
  const record = ownDataRecord(value)
  if (!record || !exactKeys(record, UNTRUSTED_CONTENT_KEYS) ||
    typeof record.source !== 'string' || !/^[a-z0-9:-]{1,160}$/.test(record.source) || !isCanonicalJsonData(record.value) ||
    record.handling !== 'data-only' || record.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS') return null
  return {
    source: record.source,
    value: record.value,
    handling: 'data-only',
    instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
  }
}

function safeProvenance(value: unknown, connectorId: string): ConnectorResult['provenance'] | null {
  const record = ownDataRecord(value)
  if (!record || !exactOptionalKeys(record, ['connectorId', 'source', 'retrievedAt', 'untrustedContent'], PROVENANCE_KEYS) ||
    record.connectorId !== connectorId || typeof record.source !== 'string' || !/^synthetic(?:[-:][a-z0-9]+)*$/.test(record.source) ||
    !validIsoTimestamp(record.retrievedAt) || (Object.hasOwn(record, 'runId') && (typeof record.runId !== 'string' || !/^[a-z0-9-]{1,160}$/.test(record.runId)))) return null
  const untrustedContent = safeUntrustedContent(record.untrustedContent)
  if (!untrustedContent) return null
  return {
    connectorId,
    source: record.source,
    retrievedAt: record.retrievedAt,
    ...(Object.hasOwn(record, 'runId') ? { runId: record.runId as string } : {}),
    untrustedContent,
  }
}

/**
 * Provenance is part of the displayed synthetic plan, not a free-form label.
 * Bind its normalized input copy to the verified snapshot so a self-consistent
 * plan cannot be relabelled as having come from another adapter.
 */
function provenanceMatchesSnapshot(
  data: unknown,
  provenance: ConnectorResult['provenance'],
  connectorId: string,
  binding: SyntheticResultReviewBinding,
): boolean {
  const dataRecord = ownDataRecord(data)
  const snapshot = dataRecord ? ownDataRecord(dataRecord.reviewSnapshot) : null
  const payload = snapshot ? ownDataRecord(snapshot.payload) : null
  if (!payload || !Object.hasOwn(payload, 'input') || provenance.retrievedAt !== binding.retrievedAt ||
    !sameCanonicalData(provenance.untrustedContent.value, payload.input)) return false
  if (connectorId === 'text-to-3d' || connectorId === 'image-text-to-3d') {
    const source = `synthetic-3d:${connectorId}`
    return provenance.source === source && provenance.untrustedContent.source === source && !Object.hasOwn(provenance, 'runId')
  }
  if (connectorId === 'game-engine') {
    return provenance.source === 'synthetic-game-engine-plan' && provenance.untrustedContent.source === 'game-engine-input' &&
      provenance.runId === dataRecord?.buildId
  }
  return false
}

/**
 * The last GM5/GM6 boundary before API serialization. It admits only the
 * known synthetic result shapes, checks each displayed plan field and
 * provenance value against the signed-by-digest review snapshot, and returns
 * a fresh frozen envelope.
 * This has no I/O and cannot turn a plan into an execution path.
 */
export function validatedSyntheticConnectorResult<TData = unknown>(value: unknown, connectorId: string, submittedInput: unknown, reviewBinding: SyntheticResultReviewBinding): ConnectorResult<TData> {
  const result = ownDataRecord(value)
  if (!result || !exactKeys(result, RESULT_KEYS) || result.confidence !== 0 || !syntheticDataMatchesSnapshot(result.data, connectorId, submittedInput, reviewBinding)) {
    throw new SyntheticResultIntegrityError()
  }
  const provenance = safeProvenance(result.provenance, connectorId)
  if (!provenance || !provenanceMatchesSnapshot(result.data, provenance, connectorId, reviewBinding)) throw new SyntheticResultIntegrityError()
  return deepFreeze({ data: result.data as TData, provenance, confidence: 0 })
}
