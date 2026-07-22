import type { PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QuotaError } from './errors.js'
import { isGovernanceRequestedItems } from './governance-limits.js'
import { isProxyValue } from './plan-integrity.js'
import type { ConnectorQuota } from './types.js'

export const GCL_USAGE_MODULE_ID = 'gcl-jnc-usage'

export type DailyQuotaConfig = {
  dailyRuns: number
  dailyItems: number
}

export type DailyQuotaEnvironmentNames = {
  dailyRuns: string
  dailyItems: string
}

export const THREE_D_DAILY_QUOTA_ENV: DailyQuotaEnvironmentNames = {
  dailyRuns: 'GCL_3D_DAILY_RUN_QUOTA',
  dailyItems: 'GCL_3D_DAILY_ITEM_QUOTA',
}

export const GAME_ENGINE_DAILY_QUOTA_ENV: DailyQuotaEnvironmentNames = {
  dailyRuns: 'GCL_GAME_ENGINE_DAILY_RUN_QUOTA',
  dailyItems: 'GCL_GAME_ENGINE_DAILY_GPU_MINUTE_QUOTA',
}

const PRODUCT_PATTERN = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const CONNECTOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/
const QUOTA_REQUEST_KEYS = ['product', 'workspaceId', 'connectorId', 'requestedItems', 'occurredAt'] as const
const GROUPED_QUOTA_REQUEST_KEYS = [...QUOTA_REQUEST_KEYS, 'quotaGroup'] as const
const DAILY_QUOTA_CONFIG_KEYS = ['dailyRuns', 'dailyItems'] as const
const DAILY_QUOTA_ENVIRONMENT_KEYS = ['dailyRuns', 'dailyItems'] as const

type QuotaReservationRequest = {
  product: string
  workspaceId: string
  connectorId: string
  quotaGroup: string
  requestedItems: number
  occurredAt: Date
}

type StoredQuotaUsage = Pick<QuotaReservationRequest, 'connectorId' | 'quotaGroup' | 'requestedItems' | 'occurredAt'>

function startOfUtcDay(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) }

function exactOwnDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxyValue(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== keys.length || names.some((name) => !keys.includes(name))) return null
    const output = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function copiedNativeDate(value: unknown): Date | null {
  try {
    if (!value || typeof value !== 'object' || isProxyValue(value) || Object.getPrototypeOf(value) !== Date.prototype) return null
    const milliseconds = Date.prototype.getTime.call(value)
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : null
  } catch {
    return null
  }
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

/**
 * The quota boundary may be called without the governed runner. Preserve the
 * same product/workspace/item envelope and copy its timestamp before any
 * storage or in-memory accounting work.
 */
function quotaReservationRequest(value: unknown): QuotaReservationRequest | null {
  const request = exactOwnDataRecord(value, GROUPED_QUOTA_REQUEST_KEYS) ?? exactOwnDataRecord(value, QUOTA_REQUEST_KEYS)
  if (!request ||
    typeof request.product !== 'string' || !PRODUCT_PATTERN.test(request.product) ||
    typeof request.workspaceId !== 'string' || !WORKSPACE_PATTERN.test(request.workspaceId) ||
    typeof request.connectorId !== 'string' || !CONNECTOR_PATTERN.test(request.connectorId) ||
    (request.quotaGroup !== undefined && (typeof request.quotaGroup !== 'string' || !CONNECTOR_PATTERN.test(request.quotaGroup))) ||
    !isGovernanceRequestedItems(request.requestedItems)) return null
  const occurredAt = copiedNativeDate(request.occurredAt)
  return occurredAt ? Object.freeze({
    product: request.product,
    workspaceId: request.workspaceId,
    connectorId: request.connectorId,
    quotaGroup: request.quotaGroup ?? request.connectorId,
    requestedItems: request.requestedItems,
    occurredAt,
  }) : null
}

function dailyQuotaConfig(value: unknown): Readonly<DailyQuotaConfig> {
  const config = exactOwnDataRecord(value, DAILY_QUOTA_CONFIG_KEYS)
  if (!config ||
    typeof config.dailyRuns !== 'number' || !Number.isSafeInteger(config.dailyRuns) || config.dailyRuns < 1 ||
    typeof config.dailyItems !== 'number' || !Number.isSafeInteger(config.dailyItems) || config.dailyItems < 1) {
    throw new ConnectorUnavailableError('CONNECTOR_QUOTA_INVALID_CONFIG')
  }
  return Object.freeze({ dailyRuns: config.dailyRuns, dailyItems: config.dailyItems })
}

function dailyQuotaEnvironmentNames(value: unknown): DailyQuotaEnvironmentNames {
  const names = exactOwnDataRecord(value, DAILY_QUOTA_ENVIRONMENT_KEYS)
  if (!names ||
    typeof names.dailyRuns !== 'string' || !/^[A-Z][A-Z0-9_]{1,119}$/.test(names.dailyRuns) ||
    typeof names.dailyItems !== 'string' || !/^[A-Z][A-Z0-9_]{1,119}$/.test(names.dailyItems)) {
    throw new ConnectorUnavailableError('CONNECTOR_QUOTA_POLICY_NOT_REGISTERED')
  }
  return Object.freeze({ dailyRuns: names.dailyRuns, dailyItems: names.dailyItems })
}

function storedQuotaReservation(value: unknown): StoredQuotaUsage | null {
  const record = exactOwnDataRecord(value, ['connectorId', 'quotaGroup', 'requestedItems', 'occurredAt', 'state']) ??
    exactOwnDataRecord(value, ['connectorId', 'requestedItems', 'occurredAt', 'state'])
  if (!record ||
    typeof record.connectorId !== 'string' || !CONNECTOR_PATTERN.test(record.connectorId) ||
    (record.quotaGroup !== undefined && (typeof record.quotaGroup !== 'string' || !CONNECTOR_PATTERN.test(record.quotaGroup))) ||
    !isGovernanceRequestedItems(record.requestedItems) ||
    !exactIsoTimestamp(record.occurredAt) || record.state !== 'reserved') return null
  const occurredAt = new Date(record.occurredAt)
  const quotaGroup = record.quotaGroup ??
    (record.connectorId === 'text-to-3d' || record.connectorId === 'image-text-to-3d' ? 'three-d' : record.connectorId)
  return Object.freeze({
    connectorId: record.connectorId, quotaGroup, requestedItems: record.requestedItems, occurredAt,
  })
}

function quotaPolicyMapping(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxyValue(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const output = Object.create(null) as Record<string, unknown>
    for (const connectorId of Object.getOwnPropertyNames(value)) {
      if (!CONNECTOR_PATTERN.test(connectorId)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, connectorId)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[connectorId] = descriptor.value
    }
    return Object.keys(output).length > 0 ? output : null
  } catch {
    return null
  }
}

/** Reservations are deliberately conservative: a failed run remains accounted for. */
export class JncPrismaDailyConnectorQuota implements ConnectorQuota {
  private readonly config: Readonly<DailyQuotaConfig>

  constructor(private readonly prisma: PrismaClient, config: DailyQuotaConfig) {
    this.config = dailyQuotaConfig(config)
  }

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    const safeRequest = quotaReservationRequest(request)
    if (!safeRequest) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    if (safeRequest.requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(safeRequest.occurredAt)
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${safeRequest.product}:${safeRequest.workspaceId}:${safeRequest.quotaGroup}:${GCL_USAGE_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: safeRequest.product, workspaceId: safeRequest.workspaceId, moduleId: GCL_USAGE_MODULE_ID, createdAt: { gte: dayStart } },
        select: { values: true },
      })
      const priorReservations = records.map((record) => storedQuotaReservation(record.values))
      if (priorReservations.some((reservation) => !reservation)) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_USAGE_CORRUPT')
      const priorItems = priorReservations
        .filter((reservation): reservation is StoredQuotaUsage => reservation !== null && reservation.quotaGroup === safeRequest.quotaGroup)
        .map((reservation) => reservation.requestedItems)
      if (priorItems.length >= this.config.dailyRuns || priorItems.reduce((total, items) => total + items, 0) + safeRequest.requestedItems > this.config.dailyItems) throw new QuotaError()
      await transaction.record.create({
        data: {
          product: safeRequest.product, workspaceId: safeRequest.workspaceId, moduleId: GCL_USAGE_MODULE_ID,
          values: { connectorId: safeRequest.connectorId, quotaGroup: safeRequest.quotaGroup, requestedItems: safeRequest.requestedItems, occurredAt: safeRequest.occurredAt.toISOString(), state: 'reserved' },
          status: 'reserved', createdBy: 'gcl-quota',
        },
      })
    })
  }
}

function environmentPositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function dailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv, names: DailyQuotaEnvironmentNames): DailyQuotaConfig {
  const safeNames = dailyQuotaEnvironmentNames(names)
  const dailyRuns = environmentPositiveInteger(environment[safeNames.dailyRuns])
  const dailyItems = environmentPositiveInteger(environment[safeNames.dailyItems])
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  dailyQuotaConfig({ dailyRuns, dailyItems })
  return { dailyRuns, dailyItems }
}

/** Selects a quota policy before any reservation; unknown connector ids fail closed. */
export class JncEnvironmentPrismaConnectorQuota implements ConnectorQuota {
  private readonly namesByConnector: Readonly<Record<string, DailyQuotaEnvironmentNames>>

  constructor(
    private readonly prisma: PrismaClient,
    private readonly environment: NodeJS.ProcessEnv,
    namesByConnector: Readonly<Record<string, DailyQuotaEnvironmentNames>>,
  ) {
    const mapping = quotaPolicyMapping(namesByConnector)
    if (!mapping) {
      throw new ConnectorUnavailableError('CONNECTOR_QUOTA_POLICY_NOT_REGISTERED')
    }
    const copied = Object.create(null) as Record<string, DailyQuotaEnvironmentNames>
    for (const [connectorId, names] of Object.entries(mapping)) copied[connectorId] = dailyQuotaEnvironmentNames(names)
    this.namesByConnector = Object.freeze(copied)
  }

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    const safeRequest = quotaReservationRequest(request)
    if (!safeRequest) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    const names = this.namesByConnector[safeRequest.connectorId]
    if (!names) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_POLICY_NOT_REGISTERED')
    return new JncPrismaDailyConnectorQuota(this.prisma, dailyQuotaFromEnvironment(this.environment, names)).consume(safeRequest)
  }
}

/** Test-only deterministic quota. */
export class JncInMemoryDailyConnectorQuota implements ConnectorQuota {
  private readonly entries: QuotaReservationRequest[] = []
  private readonly config: Readonly<DailyQuotaConfig>

  constructor(config: DailyQuotaConfig) {
    this.config = dailyQuotaConfig(config)
  }

  get reservations(): readonly QuotaReservationRequest[] {
    return Object.freeze(this.entries.map((reservation) => Object.freeze({
      ...reservation,
      occurredAt: new Date(reservation.occurredAt.getTime()),
    })))
  }

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    const safeRequest = quotaReservationRequest(request)
    if (!safeRequest) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    if (safeRequest.requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(safeRequest.occurredAt).getTime()
    const matching = this.entries.filter((reservation) => (
      reservation.product === safeRequest.product && reservation.workspaceId === safeRequest.workspaceId &&
      reservation.quotaGroup === safeRequest.quotaGroup && startOfUtcDay(reservation.occurredAt).getTime() === dayStart
    ))
    if (matching.length >= this.config.dailyRuns || matching.reduce((total, reservation) => total + reservation.requestedItems, 0) + safeRequest.requestedItems > this.config.dailyItems) throw new QuotaError()
    this.entries.push(safeRequest)
  }
}
