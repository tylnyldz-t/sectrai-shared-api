import type { PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QuotaError } from './errors.js'
import type { ConnectorQuota } from './types.js'

export const GCL_USAGE_MODULE_ID = 'gcl-usage'

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

function startOfUtcDay(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) }

function usageItems(value: unknown, connectorId: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const candidate = value as { connectorId?: unknown; requestedItems?: unknown }
  return candidate.connectorId === connectorId && typeof candidate.requestedItems === 'number' && Number.isSafeInteger(candidate.requestedItems) && candidate.requestedItems > 0 ? candidate.requestedItems : 0
}

/** Reservations are deliberately conservative: a failed run remains accounted for. */
export class PrismaDailyConnectorQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly config: DailyQuotaConfig) {}

  async consume({ product, workspaceId, connectorId, requestedItems, occurredAt }: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    if (!Number.isSafeInteger(requestedItems) || requestedItems < 1) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    if (requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(occurredAt)
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${product}:${workspaceId}:${connectorId}:${GCL_USAGE_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product, workspaceId, moduleId: GCL_USAGE_MODULE_ID, createdAt: { gte: dayStart } },
        select: { values: true },
      })
      const priorItems = records.map((record) => usageItems(record.values, connectorId)).filter((items) => items > 0)
      if (priorItems.length >= this.config.dailyRuns || priorItems.reduce((total, items) => total + items, 0) + requestedItems > this.config.dailyItems) throw new QuotaError()
      await transaction.record.create({
        data: {
          product, workspaceId, moduleId: GCL_USAGE_MODULE_ID,
          values: { connectorId, requestedItems, occurredAt: occurredAt.toISOString(), state: 'reserved' },
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
  const dailyRuns = environmentPositiveInteger(environment[names.dailyRuns])
  const dailyItems = environmentPositiveInteger(environment[names.dailyItems])
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Selects a quota policy before any reservation; unknown connector ids fail closed. */
export class EnvironmentPrismaConnectorQuota implements ConnectorQuota {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly namesByConnector: Readonly<Record<string, DailyQuotaEnvironmentNames>>,
  ) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    const names = this.namesByConnector[request.connectorId]
    if (!names) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_POLICY_NOT_REGISTERED')
    return new PrismaDailyConnectorQuota(this.prisma, dailyQuotaFromEnvironment(this.environment, names)).consume(request)
  }
}

/** Test-only deterministic quota. */
export class InMemoryDailyConnectorQuota implements ConnectorQuota {
  readonly reservations: Array<{ product: string; workspaceId: string; connectorId: string; requestedItems: number; occurredAt: Date }> = []

  constructor(private readonly config: DailyQuotaConfig) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    if (!Number.isSafeInteger(request.requestedItems) || request.requestedItems < 1 || request.requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(request.occurredAt).getTime()
    const matching = this.reservations.filter((reservation) => (
      reservation.product === request.product && reservation.workspaceId === request.workspaceId &&
      reservation.connectorId === request.connectorId && startOfUtcDay(reservation.occurredAt).getTime() === dayStart
    ))
    if (matching.length >= this.config.dailyRuns || matching.reduce((total, reservation) => total + reservation.requestedItems, 0) + request.requestedItems > this.config.dailyItems) throw new QuotaError()
    this.reservations.push({ ...request })
  }
}
