import type { PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QuotaError } from './errors.js'
import type { ConnectorQuota } from './types.js'

export const GCL_USAGE_MODULE_ID = 'gcl-usage'

export type DailyQuotaConfig = {
  dailyRuns: number
  dailyItems: number
}

function startOfUtcDay(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) }

function usageItems(value: unknown, connectorId: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const candidate = value as { connectorId?: unknown; requestedItems?: unknown }
  return candidate.connectorId === connectorId && typeof candidate.requestedItems === 'number' && Number.isSafeInteger(candidate.requestedItems) ? candidate.requestedItems : 0
}

/** Conservatively reserves attempted runs; a provider failure could still incur usage. */
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
      const connectorRecords = records.map((record) => usageItems(record.values, connectorId)).filter((items) => items > 0)
      if (connectorRecords.length >= this.config.dailyRuns || connectorRecords.reduce((total, items) => total + items, 0) + requestedItems > this.config.dailyItems) throw new QuotaError()
      await transaction.record.create({
        data: {
          product,
          workspaceId,
          moduleId: GCL_USAGE_MODULE_ID,
          values: { connectorId, requestedItems, occurredAt: occurredAt.toISOString(), state: 'reserved' },
          status: 'reserved',
          createdBy: 'gcl-quota',
        },
      })
    })
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function dailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env, prefix = 'GCL_3D'): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment[`${prefix}_DAILY_RUN_QUOTA`])
  const dailyItems = positiveInteger(environment[`${prefix}_DAILY_ITEM_QUOTA`])
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Test-only, deterministic daily quota implementation. */
export class InMemoryDailyConnectorQuota implements ConnectorQuota {
  readonly reservations: Array<{ product: string; workspaceId: string; connectorId: string; requestedItems: number; occurredAt: Date }> = []

  constructor(private readonly config: DailyQuotaConfig) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    if (!Number.isSafeInteger(request.requestedItems) || request.requestedItems < 1 || request.requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(request.occurredAt).getTime()
    const matching = this.reservations.filter((reservation) => reservation.product === request.product && reservation.workspaceId === request.workspaceId && reservation.connectorId === request.connectorId && startOfUtcDay(reservation.occurredAt).getTime() === dayStart)
    if (matching.length >= this.config.dailyRuns || matching.reduce((total, reservation) => total + reservation.requestedItems, 0) + request.requestedItems > this.config.dailyItems) throw new QuotaError()
    this.reservations.push({ ...request })
  }
}
