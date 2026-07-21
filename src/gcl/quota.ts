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

/** Failed runs retain their reservation: an adapter may have consumed capacity before failing. */
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

export function visionDailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment.GCL_VISION_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_VISION_DAILY_SCAN_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('VISION_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Missing deployment limits deliberately close only the vision connector route. */
export class EnvironmentPrismaVisionQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    return new PrismaDailyConnectorQuota(this.prisma, visionDailyQuotaFromEnvironment(this.environment)).consume(request)
  }
}
