import type { Request } from 'express'

const ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const STATUS_LIMIT = 80
const ACTOR_LIMIT = 160

export type RecordScope = { product: string; workspaceId: string; moduleId: string }
export type RecordMutation = { values: Record<string, unknown>; status: string | null; createdBy?: string }

/** GCL's audit, quota, and media ledgers are private service records, not product CRUD data. */
export function isInternalGclModuleId(moduleId: unknown): boolean { return typeof moduleId === 'string' && moduleId.startsWith('gcl-') }

export function scopeFrom(request: Request): RecordScope {
  const { product, workspaceId, moduleId } = request.params
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || typeof moduleId !== 'string') throw Object.assign(new Error('INVALID_RECORD_SCOPE'), { status: 400 })
  if (!product || !workspaceId || !moduleId || !ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(moduleId)) throw Object.assign(new Error('INVALID_RECORD_SCOPE'), { status: 400 })
  return { product, workspaceId, moduleId }
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
