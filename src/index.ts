import { PrismaClient } from '@prisma/client'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8789)
const prisma = new PrismaClient()
const app = createApp({ prisma })
const server = app.listen(port, () => console.log(`Sectrai shared API listening on :${port}`))

async function shutdown(): Promise<void> { server.close(); await prisma.$disconnect() }
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
