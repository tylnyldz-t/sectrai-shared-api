import type { Prisma } from '@prisma/client'

export type SharedRecord = {
  id: string
  product: string
  workspaceId: string
  moduleId: string
  values: Record<string, unknown>
  status: string | null
  createdAt: string
  updatedAt: string
  createdBy: string
}

export function serializeRecord(record: { id: string; product: string; workspaceId: string; moduleId: string; values: Prisma.JsonValue; status: string | null; createdAt: Date; updatedAt: Date; createdBy: string }): SharedRecord {
  return { ...record, values: record.values as Record<string, unknown>, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() }
}
