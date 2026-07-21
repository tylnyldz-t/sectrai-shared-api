import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const MARKET_CONNECTOR_ID = 'market'
export const MARKET_LIVE_STATUS = 'MARKET_LIVE_DISABLED'

export type MarketOperation = 'freight-discovery' | 'capacity-discovery' | 'capacity-quote'
export type MarketTransportMode = 'road' | 'sea' | 'rail' | 'air'

type MarketRequestFields = {
  operation: MarketOperation
  transportMode: MarketTransportMode
  originCountry: string
  destinationCountry: string
  requestedListings: number
}

export type MarketDiscoveryInput = MarketRequestFields & {
  operation: 'freight-discovery' | 'capacity-discovery'
}

export type MarketCapacityQuoteInput = MarketRequestFields & {
  operation: 'capacity-quote'
  requestedCapacityUnits: number
}

export type SyntheticMarketInput = MarketDiscoveryInput | MarketCapacityQuoteInput

export type SyntheticMarketConnectorConfig = {
  /**
   * There is no real-provider implementation in this connector. A true value
   * is deliberately a failure, rather than an opt-in.
   */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
  maxCapacityUnits?: number
}

type ConfiguredMarketLimits = Required<Omit<SyntheticMarketConnectorConfig, 'liveEnabled'>>

export type SyntheticMarketPlan = {
  id: string
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'OWNER_REVIEW_REQUIRED'
  request: SyntheticMarketInput
  sources: readonly {
    id: 'internal-capacity-market' | 'hub-connect'
    state: 'NOT_QUERIED' | 'NOT_CONTACTED'
    autoSync: false
    credentialsAccepted: false
  }[]
  quote: { state: 'NOT_QUOTED'; reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' } | null
  sideEffects: {
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function exactObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  const object = input as Record<string, unknown>
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  return object
}

function marketOperation(value: unknown): MarketOperation {
  if (value !== 'freight-discovery' && value !== 'capacity-discovery' && value !== 'capacity-quote') throw new ConnectorInputError('INVALID_MARKET_OPERATION')
  return value
}

function transportMode(value: unknown): MarketTransportMode {
  if (value !== 'road' && value !== 'sea' && value !== 'rail' && value !== 'air') throw new ConnectorInputError('INVALID_MARKET_TRANSPORT_MODE')
  return value
}

function country(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z]{2}$/.test(value)) throw new ConnectorInputError('INVALID_MARKET_COUNTRY')
  return value.toUpperCase()
}

function requestedListings(value: unknown, maxItems: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > maxItems) throw new ConnectorInputError('INVALID_MARKET_REQUESTED_LISTINGS')
  return parsed
}

function requestedCapacityUnits(value: unknown, maxCapacityUnits: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > maxCapacityUnits) throw new ConnectorInputError('INVALID_MARKET_CAPACITY_UNITS')
  return parsed
}

function configured(config: SyntheticMarketConnectorConfig, ctx: ConnectorRunContext): ConfiguredMarketLimits {
  if (config.liveEnabled) throw new ConnectorUnavailableError(MARKET_LIVE_STATUS)
  const maxCostCapCents = positiveInteger(config.maxCostCapCents)
  const maxItems = positiveInteger(config.maxItems)
  const maxCapacityUnits = positiveInteger(config.maxCapacityUnits)
  if (!maxCostCapCents || !maxItems || !maxCapacityUnits) throw new ConnectorUnavailableError('MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
  if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  return { maxCostCapCents, maxItems, maxCapacityUnits }
}

function parse(input: unknown, limits: ConfiguredMarketLimits): SyntheticMarketInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  const candidate = input as Record<string, unknown>
  const operation = marketOperation(candidate.operation)
  const object = exactObject(input, operation === 'capacity-quote'
    ? ['operation', 'transportMode', 'originCountry', 'destinationCountry', 'requestedListings', 'requestedCapacityUnits']
    : ['operation', 'transportMode', 'originCountry', 'destinationCountry', 'requestedListings'])
  const base: MarketRequestFields = {
    operation,
    transportMode: transportMode(object.transportMode),
    originCountry: country(object.originCountry),
    destinationCountry: country(object.destinationCountry),
    requestedListings: requestedListings(object.requestedListings, limits.maxItems),
  }
  if (operation === 'capacity-quote') {
    return { ...base, operation, requestedCapacityUnits: requestedCapacityUnits(object.requestedCapacityUnits, limits.maxCapacityUnits) }
  }
  return { ...base, operation }
}

function planId(request: SyntheticMarketInput, ctx: ConnectorRunContext): string {
  const material = JSON.stringify({ product: ctx.product, workspaceId: ctx.workspaceId, request })
  return 'synthetic-market-' + createHash('sha256').update(material).digest('hex').slice(0, 24)
}

/**
 * A proposal-only market adapter. It deliberately has no provider address,
 * fetch client, credential field, scheduler, persistence side effect, booking,
 * reservation, or publishing path. Its Hub Connect and capacity-market
 * references are named states, never integrations.
 */
export class SyntheticMarketConnector implements Connector<SyntheticMarketInput, SyntheticMarketPlan> {
  readonly id = MARKET_CONNECTOR_ID
  readonly kind = 'market' as const
  readonly authKind = 'owner-token' as const
  readonly quotaGroup = 'market'
  readonly scopes = ['market:discover', 'market:capacity:quote'] as const

  constructor(private readonly config: SyntheticMarketConnectorConfig = {}) {}

  preflight(input: SyntheticMarketInput, ctx: ConnectorRunContext): void {
    const limits = configured(this.config, ctx)
    const request = parse(input, limits)
    if (request.requestedListings !== ctx.requestedItems) throw new CostCapError('MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
    const requiredScope = request.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
    if (!ctx.scopes.includes(requiredScope)) throw new ConnectorInputError('MARKET_OPERATION_SCOPE_REQUIRED')
  }

  async run(input: SyntheticMarketInput, ctx: ConnectorRunContext): Promise<ConnectorResult<SyntheticMarketPlan>> {
    const limits = configured(this.config, ctx)
    const request = parse(input, limits)
    if (request.requestedListings !== ctx.requestedItems) throw new CostCapError('MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
    const requiredScope = request.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
    if (!ctx.scopes.includes(requiredScope)) throw new ConnectorInputError('MARKET_OPERATION_SCOPE_REQUIRED')
    const plan: SyntheticMarketPlan = {
      id: planId(request, ctx),
      mode: 'SYNTHETIC',
      liveStatus: 'LIVE_DISABLED',
      state: 'OWNER_REVIEW_REQUIRED',
      request,
      sources: [
        { id: 'internal-capacity-market', state: 'NOT_QUERIED', autoSync: false, credentialsAccepted: false },
        { id: 'hub-connect', state: 'NOT_CONTACTED', autoSync: false, credentialsAccepted: false },
      ],
      quote: request.operation === 'capacity-quote'
        ? { state: 'NOT_QUOTED', reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' }
        : null,
      sideEffects: { externalNetwork: false, reservation: false, booking: false, publication: false },
    }
    return {
      data: plan,
      provenance: {
        connectorId: this.id,
        source: 'synthetic-market-proposal',
        retrievedAt: ctx.now().toISOString(),
        runId: plan.id,
        untrustedContent: {
          source: 'synthetic-market-request',
          value: request,
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** A true live flag closes the connector. It can never enable a provider. */
export function syntheticMarketConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticMarketConnector {
  return new SyntheticMarketConnector({
    liveEnabled: environment.GCL_MARKET_LIVE_ENABLED === 'true',
    maxCostCapCents: environmentPositiveInteger(environment.GCL_MARKET_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_MARKET_MAX_ITEMS),
    maxCapacityUnits: environmentPositiveInteger(environment.GCL_MARKET_MAX_CAPACITY_UNITS),
  })
}
