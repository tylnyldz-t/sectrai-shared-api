import type { PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QuotaError } from './errors.js'
import type { ConnectorQuota } from './types.js'

export const GCL_USAGE_MODULE_ID = 'gcl-usage'

export type DailyQuotaConfig = {
  dailyRuns: number
  dailyItems: number
}

function startOfUtcDay(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())) }

function usageItems(value: unknown, quotaGroup: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const candidate = value as { connectorId?: unknown; quotaGroup?: unknown; requestedItems?: unknown }
  const recordedGroup = typeof candidate.quotaGroup === 'string' ? candidate.quotaGroup : candidate.connectorId
  return recordedGroup === quotaGroup && typeof candidate.requestedItems === 'number' && Number.isSafeInteger(candidate.requestedItems) ? candidate.requestedItems : 0
}

/**
 * Stores conservative attempted-run reservations. A failed upstream run still
 * consumes quota because it may already have incurred provider usage.
 */
export class PrismaDailyConnectorQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly config: DailyQuotaConfig) {}

  async consume({ product, workspaceId, connectorId, quotaGroup = connectorId, requestedItems, occurredAt }: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    if (!Number.isSafeInteger(requestedItems) || requestedItems < 1) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    if (requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(occurredAt)
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${product}:${workspaceId}:${quotaGroup}:${GCL_USAGE_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product, workspaceId, moduleId: GCL_USAGE_MODULE_ID, createdAt: { gte: dayStart } },
        select: { values: true },
      })
      const connectorRecords = records.map((record) => usageItems(record.values, quotaGroup)).filter((items) => items > 0)
      if (connectorRecords.length >= this.config.dailyRuns || connectorRecords.reduce((total, items) => total + items, 0) + requestedItems > this.config.dailyItems) throw new QuotaError()
      await transaction.record.create({
        data: {
          product,
          workspaceId,
          moduleId: GCL_USAGE_MODULE_ID,
          values: { connectorId, quotaGroup, requestedItems, occurredAt: occurredAt.toISOString(), state: 'reserved' },
          status: 'reserved',
          createdBy: 'gcl-quota',
        },
      })
    })
  }
}

/** Resolves deployment limits at run time so a missing GCL configuration only
 * closes the connector route, not unrelated shared-record API routes. */
export class EnvironmentPrismaDailyConnectorQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    return new PrismaDailyConnectorQuota(this.prisma, dailyQuotaFromEnvironment(this.environment, request.quotaGroup ?? request.connectorId)).consume(request)
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function quotaEnvironmentPrefix(quotaGroup: string): 'GCL_MARKET' | null {
  if (quotaGroup === 'market') return 'GCL_MARKET'
  return null
}

export function dailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env, quotaGroup = 'market'): DailyQuotaConfig {
  const prefix = quotaEnvironmentPrefix(quotaGroup)
  if (!prefix) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  const dailyRuns = positiveInteger(environment[`${prefix}_DAILY_RUN_QUOTA`])
  const dailyItems = positiveInteger(environment[`${prefix}_DAILY_ITEM_QUOTA`])
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}
