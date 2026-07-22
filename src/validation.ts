import type { Request } from 'express'
import { MAX_GOVERNANCE_SCOPE_COUNT } from './gcl/governance-limits.js'

const ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const STATUS_LIMIT = 80
const ACTOR_LIMIT = 160

export type RecordScope = { product: string; workspaceId: string; moduleId: string }
export type RecordMutation = { values: Record<string, unknown>; status: string | null; createdBy?: string }
export type WorkspaceScope = { product: string; workspaceId: string }
export type ConnectorRunMutation = { input: Record<string, unknown>; scopes: string[]; costCapCents: number; requestedItems: number }

export function scopeFrom(request: Request): RecordScope {
  const { product, workspaceId, moduleId } = request.params
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || typeof moduleId !== 'string') throw Object.assign(new Error('INVALID_RECORD_SCOPE'), { status: 400 })
  if (!product || !workspaceId || !moduleId || !ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(moduleId)) throw Object.assign(new Error('INVALID_RECORD_SCOPE'), { status: 400 })
  return { product, workspaceId, moduleId }
}

export function workspaceScopeFrom(request: Request): WorkspaceScope {
  const { product, workspaceId } = request.params
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || !product || !workspaceId || !ID_PATTERN.test(workspaceId)) throw Object.assign(new Error('INVALID_WORKSPACE_SCOPE'), { status: 400 })
  return { product, workspaceId }
}

function jsonSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function values(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || jsonSize(value) > 48 * 1024) throw Object.assign(new Error('INVALID_RECORD_VALUES'), { status: 422 })
  return value as Record<string, unknown>
}
function status(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.trim().length > STATUS_LIMIT) throw Object.assign(new Error('INVALID_RECORD_STATUS'), { status: 422 })
  return value.trim()
}
function actor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > ACTOR_LIMIT) throw Object.assign(new Error('INVALID_RECORD_ACTOR'), { status: 422 })
  return value.trim()
}
export function mutationFrom(body: unknown, allowCreatedBy: boolean): RecordMutation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('INVALID_REQUEST_BODY'), { status: 400 })
  const input = body as Record<string, unknown>
  const allowed = allowCreatedBy ? new Set(['values', 'status', 'createdBy']) : new Set(['values', 'status'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw Object.assign(new Error('UNEXPECTED_RECORD_FIELD'), { status: 400 })
  return { values: values(input.values), status: status(input.status), ...(allowCreatedBy ? { createdBy: actor(input.createdBy) } : {}) }
}

function exactObject(body: unknown, allowed: readonly string[], error: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error(error), { status: 400 })
  const input = body as Record<string, unknown>
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw Object.assign(new Error(error), { status: 400 })
  return input
}

function shortText(value: unknown, error: string, limit = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw Object.assign(new Error(error), { status: 422 })
  return value.trim()
}

function stringArray(value: unknown, error: string, limit: number, itemLimit = 120): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) throw Object.assign(new Error(error), { status: 422 })
  const output = value.map((item) => shortText(item, error, itemLimit))
  if (new Set(output).size !== output.length) throw Object.assign(new Error(error), { status: 422 })
  return output
}

function positiveInteger(value: unknown, error: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limit) throw Object.assign(new Error(error), { status: 422 })
  return value
}

export function connectorRunFrom(body: unknown): ConnectorRunMutation {
  const input = exactObject(body, ['input', 'scopes', 'costCapCents', 'requestedItems'], 'INVALID_CONNECTOR_RUN_REQUEST')
  return {
    input: values(input.input),
    scopes: stringArray(input.scopes, 'INVALID_CONNECTOR_SCOPES', MAX_GOVERNANCE_SCOPE_COUNT, 80),
    costCapCents: positiveInteger(input.costCapCents, 'INVALID_CONNECTOR_COST_CAP', 10_000_000),
    requestedItems: positiveInteger(input.requestedItems, 'INVALID_CONNECTOR_REQUESTED_ITEMS', 100_000),
  }
}
