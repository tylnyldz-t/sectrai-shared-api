import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app.js'

const databaseUrl = process.env.DATABASE_URL
const product = 'sectrai-integration-test'
const key = `test-${randomUUID()}`
process.env.SHARED_API_KEY_INTEGRATION_TEST = key

async function running(): Promise<{ prisma: PrismaClient; server: Server; base: string }> {
  const prisma = new PrismaClient()
  const app = createApp({ prisma })
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const value = app.listen(0, () => resolve(value)) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
  const base = `http://127.0.0.1:${address.port}/api/products/${product}/workspaces/ws-integration/modules/module-crud/records`
  return { prisma, server, base }
}
async function close(server: Server, prisma: PrismaClient): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await prisma.$disconnect() }
const headers = { 'content-type': 'application/json', 'x-sectrai-product-key': key }

test('real Neon CRUD persists across a new Prisma connection and rejects missing product keys', { skip: !databaseUrl && 'DATABASE_URL is required for the optional real Neon integration test' }, async () => {
  const first = await running()
  let recordId = ''
  try {
    assert.equal((await fetch(first.base)).status, 401)
    const created = await fetch(first.base, { method: 'POST', headers, body: JSON.stringify({ values: { title: 'Synthetic integration record', count: 1 }, status: 'draft', createdBy: 'integration-test' }) })
    assert.equal(created.status, 201)
    const record = (await created.json() as { record: { id: string; product: string; values: { count: number } } }).record
    recordId = record.id
    assert.equal(record.product, product)
    assert.equal(record.values.count, 1)
    const listed = await fetch(first.base, { headers })
    assert.equal((await listed.json() as { records: unknown[] }).records.length, 1)
    const edited = await fetch(`${first.base}/${recordId}`, { method: 'PATCH', headers, body: JSON.stringify({ values: { title: 'Synthetic integration record', count: 2 }, status: 'reviewed' }) })
    assert.equal(edited.status, 200)
    assert.equal((await edited.json() as { record: { values: { count: number } } }).record.values.count, 2)
  } finally { await close(first.server, first.prisma) }

  const restarted = await running()
  try {
    const persisted = await fetch(restarted.base, { headers })
    const records = (await persisted.json() as { records: Array<{ id: string; values: { count: number } }> }).records
    assert.equal(records.some((record) => record.id === recordId && record.values.count === 2), true)
    const deleted = await fetch(`${restarted.base}/${recordId}`, { method: 'DELETE', headers })
    assert.equal(deleted.status, 204)
    assert.equal((await fetch(restarted.base, { headers }).then((response) => response.json()) as { records: unknown[] }).records.length, 0)
  } finally { await restarted.prisma.record.deleteMany({ where: { product } }); await close(restarted.server, restarted.prisma) }
})
