/**
 * Structural view of the existing Record table used by GCL audit and quota
 * implementations. It adds no schema and keeps the connector testable without
 * constructing a Prisma client.
 */
export type GclStoredRecord = {
  id: string
  values: unknown
  createdAt: Date
}

type GclRecordData = {
  product: string
  workspaceId: string
  moduleId: string
  values: unknown
  status: string
  createdBy: string
}

export type GclRecordTransaction = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  record: {
    findFirst(input: { where: { product: string; workspaceId: string; moduleId: string }; orderBy: Array<{ createdAt: 'desc' } | { id: 'desc' }> }): Promise<GclStoredRecord | null>
    findMany(input: { where: { product: string; workspaceId: string; moduleId: string; createdAt?: { gte: Date } }; orderBy?: Array<{ createdAt: 'asc' | 'desc' } | { id: 'asc' | 'desc' }>; select: { values: true } }): Promise<Array<Pick<GclStoredRecord, 'values'>>>
    create(input: { data: GclRecordData }): Promise<unknown>
  }
}

export interface GclPersistence {
  $transaction<T>(operation: (transaction: GclRecordTransaction) => Promise<T>): Promise<T>
}
