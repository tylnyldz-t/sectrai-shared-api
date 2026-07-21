import type { PrismaClient } from '@prisma/client'
import { PrismaHashChainAuditLog } from './audit.js'
import { dailyQuotaFromEnvironment, PrismaDailyConnectorQuota } from './quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from './registry.js'
import { syntheticThreeDConnectorsFromEnvironment } from './three-d.js'

/**
 * Application composition root for GM5. It intentionally exposes no HTTP
 * route and no provider client: a caller must explicitly invoke the governed
 * runner after its own product-level owner workflow has completed.
 */
export function createGovernedThreeDRunner(
  prisma: PrismaClient,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): GovernedConnectorRunner {
  return new GovernedConnectorRunner(
    new ConnectorRegistry(syntheticThreeDConnectorsFromEnvironment(environment)),
    new PrismaHashChainAuditLog(prisma),
    new PrismaDailyConnectorQuota(prisma, dailyQuotaFromEnvironment(environment)),
    now,
  )
}
