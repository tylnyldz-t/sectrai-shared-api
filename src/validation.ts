import type { Request } from 'express'
import type { ExtensionInput, ExtensionSuggestionInput } from './gcl/extensions.js'

const ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const STATUS_LIMIT = 80
const ACTOR_LIMIT = 160

export type RecordScope = { product: string; workspaceId: string; moduleId: string }
export type RecordMutation = { values: Record<string, unknown>; status: string | null; createdBy?: string }
export type WorkspaceScope = { product: string; workspaceId: string }
export type ConnectorRunMutation = { input: Record<string, unknown>; scopes: string[]; costCapCents: number; requestedItems: number; correlationId?: string }
export type TranslationArtifactApprovalMutation = { decision: 'approved' | 'rejected'; reviewDigest: string }

/**
 * Only deliberately constructed request-validation failures may expose their
 * stable identifier at the HTTP boundary. Runtime and adapter failures must
 * never be treated as client-safe just because they carry a `status` field.
 */
export class RequestValidationError extends Error {
  constructor(message: string, readonly status: 400 | 422) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

/** GCL's audit, quota, and media ledgers are private service records, not product CRUD data. */
export function isInternalGclModuleId(moduleId: unknown): boolean { return typeof moduleId === 'string' && moduleId.startsWith('gcl-') }

export function scopeFrom(request: Request): RecordScope {
  const { product, workspaceId, moduleId } = request.params
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || typeof moduleId !== 'string') throw new RequestValidationError('INVALID_RECORD_SCOPE', 400)
  if (!product || !workspaceId || !moduleId || !ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(moduleId)) throw new RequestValidationError('INVALID_RECORD_SCOPE', 400)
  return { product, workspaceId, moduleId }
}

export function workspaceScopeFrom(request: Request): WorkspaceScope {
  const { product, workspaceId } = request.params
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || !product || !workspaceId || !ID_PATTERN.test(workspaceId)) throw new RequestValidationError('INVALID_WORKSPACE_SCOPE', 400)
  return { product, workspaceId }
}

function jsonSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function values(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || jsonSize(value) > 48 * 1024) throw new RequestValidationError('INVALID_RECORD_VALUES', 422)
  return value as Record<string, unknown>
}
function status(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > STATUS_LIMIT) throw new RequestValidationError('INVALID_RECORD_STATUS', 422)
  return value.trim()
}
function actor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > ACTOR_LIMIT) throw new RequestValidationError('INVALID_RECORD_ACTOR', 422)
  return value.trim()
}

function exactObject(body: unknown, allowed: readonly string[], error: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError(error, 400)
  const input = body as Record<string, unknown>
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new RequestValidationError(error, 400)
  return input
}

function plainObject(value: unknown, error: string, limit = 48 * 1024): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || jsonSize(value) > limit) throw new RequestValidationError(error, 422)
  return value as Record<string, unknown>
}

function stringArray(value: unknown, error: string, limit: number, itemLimit = 120): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) throw new RequestValidationError(error, 422)
  // Scopes carry authority into the audit chain. Do not rewrite a caller's
  // scope string at the HTTP boundary: a padded value must be rejected, not
  // silently converted into a different accepted authority envelope.
  const output = value.map((item) => typeof item === 'string' && item.trim() === item && Boolean(item) && item.length <= itemLimit ? item : null)
  if (output.some((item) => item === null) || new Set(output).size !== output.length) throw new RequestValidationError(error, 422)
  return output as string[]
}

function positiveInteger(value: unknown, error: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limit) throw new RequestValidationError(error, 422)
  return value
}

function correlationId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(value)) throw new RequestValidationError('INVALID_CONNECTOR_CORRELATION_ID', 422)
  return value
}

function shortText(value: unknown, error: string, limit = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new RequestValidationError(error, 422)
  return value.trim()
}
export function mutationFrom(body: unknown, allowCreatedBy: boolean): RecordMutation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestValidationError('INVALID_REQUEST_BODY', 400)
  const input = body as Record<string, unknown>
  const allowed = allowCreatedBy ? new Set(['values', 'status', 'createdBy']) : new Set(['values', 'status'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new RequestValidationError('UNEXPECTED_RECORD_FIELD', 400)
  return { values: values(input.values), status: status(input.status), ...(allowCreatedBy ? { createdBy: actor(input.createdBy) } : {}) }
}

export function connectorRunFrom(body: unknown): ConnectorRunMutation {
  const input = exactObject(body, ['input', 'scopes', 'costCapCents', 'requestedItems', 'correlationId'], 'INVALID_CONNECTOR_RUN_REQUEST')
  return {
    input: plainObject(input.input, 'INVALID_CONNECTOR_INPUT'),
    scopes: stringArray(input.scopes, 'INVALID_CONNECTOR_SCOPES', 12, 80),
    costCapCents: positiveInteger(input.costCapCents, 'INVALID_CONNECTOR_COST_CAP', 10_000_000),
    requestedItems: positiveInteger(input.requestedItems, 'INVALID_CONNECTOR_REQUESTED_ITEMS', 100_000),
    ...(input.correlationId === undefined ? {} : { correlationId: correlationId(input.correlationId) }),
  }
}

export function translationArtifactApprovalFrom(body: unknown): TranslationArtifactApprovalMutation {
  const input = exactObject(body, ['decision', 'reviewDigest'], 'INVALID_TRANSLATION_ARTIFACT_APPROVAL')
  if (input.decision !== 'approved' && input.decision !== 'rejected') throw new RequestValidationError('INVALID_TRANSLATION_ARTIFACT_DECISION', 422)
  if (typeof input.reviewDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.reviewDigest)) throw new RequestValidationError('INVALID_TRANSLATION_ARTIFACT_REVIEW_DIGEST', 422)
  return { decision: input.decision, reviewDigest: input.reviewDigest }
}

export function extensionFrom(body: unknown): ExtensionInput {
  const input = exactObject(body, ['name', 'sector', 'role', 'connectorId', 'defaultScopes', 'consentState'], 'INVALID_EXTENSION_REQUEST')
  if (input.role !== 'ai-support' && input.role !== 'add-on-module') throw new RequestValidationError('INVALID_EXTENSION_ROLE', 422)
  if (input.consentState !== 'pending' && input.consentState !== 'granted' && input.consentState !== 'revoked') throw new RequestValidationError('INVALID_EXTENSION_CONSENT_STATE', 422)
  return {
    name: shortText(input.name, 'INVALID_EXTENSION_NAME'),
    sector: stringArray(input.sector, 'INVALID_EXTENSION_SECTOR', 12, 80),
    role: input.role,
    connectorId: shortText(input.connectorId, 'INVALID_EXTENSION_CONNECTOR_ID', 120),
    defaultScopes: stringArray(input.defaultScopes, 'INVALID_EXTENSION_SCOPES', 12, 80),
    consentState: input.consentState,
  }
}

export function extensionSuggestionFrom(body: unknown): ExtensionSuggestionInput {
  const input = exactObject(body, ['sector', 'activeModules', 'lastCommand'], 'INVALID_EXTENSION_SUGGESTION_REQUEST')
  if (input.lastCommand !== null && input.lastCommand !== undefined && (typeof input.lastCommand !== 'string' || input.lastCommand.length > 500)) throw new RequestValidationError('INVALID_EXTENSION_LAST_COMMAND', 422)
  return {
    sector: shortText(input.sector, 'INVALID_EXTENSION_SECTOR', 80),
    activeModules: stringArray(input.activeModules, 'INVALID_EXTENSION_ACTIVE_MODULES', 40, 120),
    lastCommand: typeof input.lastCommand === 'string' ? input.lastCommand.trim() : null,
  }
}
