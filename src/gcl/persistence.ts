/**
 * Minimal structural view of the shared Record persistence backbone used by
 * GCL. Keeping this contract local makes the connector layer testable without
 * a generated ORM client and does not add a runtime database dependency.
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
