import type { PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QuotaError } from './errors.js'
import type { ConnectorQuota } from './types.js'

export const GCL_USAGE_MODULE_ID = 'gcl-usage'
export const GCL_VISION_USAGE_MODULE_ID = 'gcl-vision-usage'

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

/** Failed starts remain reserved: a future non-synthetic adapter may have incurred a cost before failing. */
export class PrismaDailyConnectorQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly config: DailyQuotaConfig, private readonly moduleId = GCL_USAGE_MODULE_ID) {}

  async consume({ product, workspaceId, connectorId, quotaGroup = connectorId, requestedItems, occurredAt }: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    if (!Number.isSafeInteger(requestedItems) || requestedItems < 1) throw new QuotaError('INVALID_CONNECTOR_QUOTA_REQUEST')
    if (requestedItems > this.config.dailyItems) throw new QuotaError()
    const dayStart = startOfUtcDay(occurredAt)
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${product}:${workspaceId}:${quotaGroup}:${this.moduleId}`}))`
      const records = await transaction.record.findMany({
        where: { product, workspaceId, moduleId: this.moduleId, createdAt: { gte: dayStart } },
        select: { values: true },
      })
      const connectorRecords = records.map((record) => usageItems(record.values, quotaGroup)).filter((items) => items > 0)
      if (connectorRecords.length >= this.config.dailyRuns || connectorRecords.reduce((total, items) => total + items, 0) + requestedItems > this.config.dailyItems) throw new QuotaError()
      await transaction.record.create({
        data: {
          product,
          workspaceId,
          moduleId: this.moduleId,
          values: { connectorId, quotaGroup, requestedItems, occurredAt: occurredAt.toISOString(), state: 'reserved' },
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

/** Missing limits deliberately disable both synthetic translation connector routes. */
export function translationDailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment.GCL_TRANSLATION_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_TRANSLATION_DAILY_ITEM_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('TRANSLATION_CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

export class EnvironmentPrismaDailyConnectorQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    const vision = request.connectorId === 'vision-document-field-extraction'
    const camera = request.connectorId === 'camera-observation'
    const image = request.connectorId === 'image-tti'
    const market = request.quotaGroup === 'market' || request.connectorId === 'market'
    const config = market ? dailyQuotaFromEnvironment(this.environment, 'market') : image ? imageDailyQuotaFromEnvironment(this.environment) : camera ? cameraDailyQuotaFromEnvironment(this.environment) : vision ? visionDailyQuotaFromEnvironment(this.environment) : translationDailyQuotaFromEnvironment(this.environment)
    const moduleId = vision ? GCL_VISION_USAGE_MODULE_ID : GCL_USAGE_MODULE_ID
    return new PrismaDailyConnectorQuota(this.prisma, config, moduleId).consume(request)
  }
}

export function dailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env, quotaGroup = 'market'): DailyQuotaConfig {
  if (quotaGroup !== 'market') throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  const dailyRuns = positiveInteger(environment.GCL_MARKET_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_MARKET_DAILY_ITEM_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Missing or malformed deployment limits leave the connector closed. */
export function visionDailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment.GCL_VISION_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_VISION_DAILY_ITEM_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('VISION_CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

export function cameraDailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment.GCL_CAMERA_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_CAMERA_DAILY_OBSERVATION_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('CAMERA_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Missing or malformed limits close the synthetic image connector. */
export function imageDailyQuotaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): DailyQuotaConfig {
  const dailyRuns = positiveInteger(environment.GCL_IMAGE_DAILY_RUN_QUOTA)
  const dailyItems = positiveInteger(environment.GCL_IMAGE_DAILY_ITEM_QUOTA)
  if (!dailyRuns || !dailyItems) throw new ConnectorUnavailableError('IMAGE_CONNECTOR_QUOTA_NOT_CONFIGURED')
  return { dailyRuns, dailyItems }
}

/** Missing deployment limits close only the camera connector route. */
export class EnvironmentPrismaCameraQuota implements ConnectorQuota {
  constructor(private readonly prisma: PrismaClient, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    return new PrismaDailyConnectorQuota(this.prisma, cameraDailyQuotaFromEnvironment(this.environment)).consume(request)
  }
}
