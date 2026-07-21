import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'
import test from 'node:test'

type Snapshot = {
  name: string
  revision: string
  directory: string
  connectorPath: string
  connectorBlob: string
  registryBlob: string
  hardDeniesLiveOptIn: boolean
  quotaFailureAudited: boolean
}

const AUDIT_WORKTREE_ROOT = '/home/tayla/projects/_wt'
const GCL_ROOT = 'src/gcl/'

/*
 * These are immutable local Git snapshots from the D1 audit batch. Every
 * source read below is `git show <revision>:<path>`, never the mutable
 * worktree file. This fixture does not import target runtime code, load an
 * env file, open a socket, or make a network request. A missing worktree,
 * revision, blob, or local GCL dependency is an audit failure.
 */
const snapshots: readonly Snapshot[] = [
  { name: 'RA voice', revision: '80a1cc6', directory: 'night-ra-voice', connectorPath: 'src/gcl/voice.ts', connectorBlob: '1c232082a4bf8f6595afb2f6410f9f4d6c75fda0', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA OCR', revision: 'f6f28d7', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '13f4909cd4bf59425f68e92b8c3b73b10478f3ba', registryBlob: '3c50365d0713b025117af6cb95dafd08c371340f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA image', revision: '4d0806b', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '224d9ef7d89b7d04f9df56e873b9a78bfe28da31', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA 3D/game', revision: '7e5b947', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '285decdf4809589cecdd3cb9462995b885491f2b', registryBlob: '5638ef935dd727f27c31c6be1f918bc502ecd214', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA market', revision: '1b53141', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '4b404e7d4737f324f74b3a8ca2386aa084a2b064', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { name: 'RFID', revision: '7b14d54', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '3c8d0cd1529f2dfd32f5e0e4ed18a2b59f96bd46', registryBlob: '73e2c802a9722f79d9a06acd085126a0835e5ae3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Translation', revision: '43541af', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '5e04a2a0656f5cf9b66dcfe153a73c5cb2721bc3', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Language education', revision: '2635230', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '386c4ab68fa0f1dfcb4d89e5213358ada0df3d89', registryBlob: 'b5a42f40fb070933dc6123665d38957e8e1df9c3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Camera', revision: '0c166df', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '6682bf3b5b7ff73d14e3d1aed74a98ce2d32c63c', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
]

function repositoryFor(snapshot: Snapshot): string {
  if (!/^[a-z0-9-]+$/.test(snapshot.directory)) throw new Error(`D1_AUDIT_INVALID_WORKTREE:${snapshot.name}`)
  if (!/^[a-f0-9]{7,40}$/.test(snapshot.revision)) throw new Error(`D1_AUDIT_INVALID_REVISION:${snapshot.name}`)
  return path.join(AUDIT_WORKTREE_ROOT, snapshot.directory)
}

function gitAt(snapshot: Snapshot, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryFor(snapshot), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(`D1_AUDIT_SNAPSHOT_UNAVAILABLE:${snapshot.name}:${args.join(' ')}`)
  }
}

function sourceAt(snapshot: Snapshot, relativePath: string): string {
  if (!relativePath.startsWith(GCL_ROOT) || !relativePath.endsWith('.ts')) throw new Error(`D1_AUDIT_INVALID_SOURCE_PATH:${snapshot.name}:${relativePath}`)
  return gitAt(snapshot, ['show', `${snapshot.revision}:${relativePath}`])
}

function gitBlobId(source: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source, 'utf8')}\0`).update(source).digest('hex')
}

function localGclImportPaths(relativePath: string, source: string): readonly string[] {
  const imports = new Set<string>()
  for (const match of source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const importedPath = match[1]
    if (!importedPath) continue
    const resolved = path.normalize(path.join(path.dirname(relativePath), importedPath)).replace(/\.js$/, '.ts')
    if (!resolved.startsWith(GCL_ROOT) || !resolved.endsWith('.ts')) throw new Error(`D1_AUDIT_GCL_BOUNDARY_ESCAPE:${relativePath}:${importedPath}`)
    imports.add(resolved)
  }
  return [...imports]
}

function sourceClosure(snapshot: Snapshot): ReadonlyMap<string, string> {
  const pending = [snapshot.connectorPath, 'src/gcl/registry.ts']
  const sources = new Map<string, string>()
  while (pending.length > 0) {
    const relativePath = pending.pop()
    if (!relativePath || sources.has(relativePath)) continue
    const source = sourceAt(snapshot, relativePath)
    sources.set(relativePath, source)
    pending.push(...localGclImportPaths(relativePath, source))
  }
  return sources
}

function auditCapturesQuotaFailure(registry: string): boolean {
  const requestedAudit = registry.indexOf('const requestedAudit')
  const protectedExecution = registry.indexOf('try {', requestedAudit)
  const quota = registry.indexOf('await this.quota.consume', requestedAudit)
  const failureAudit = Math.max(
    registry.indexOf("type: 'connector.run.failed'", quota),
    registry.indexOf("this.event('connector.run.failed'", quota),
  )
  const requestedLink = registry.indexOf('requestedAuditHash: requestedAudit.hash', failureAudit)
  return requestedAudit >= 0 && protectedExecution > requestedAudit && protectedExecution < quota && failureAudit > quota && requestedLink > failureAudit
}

function hardDeniesLiveOptIn(connector: string): boolean {
  return /if \((?:this\.)?config\.liveEnabled\) throw new ConnectorUnavailableError/.test(connector)
}

function ownerDenialPrecedesReservations(registry: string): boolean {
  const ownerGate = registry.search(/if \(!(?:request|context)\.ownerApproved\) throw new OwnerGateError/)
  const preflight = registry.indexOf('await connector.preflight')
  const requestedAudit = registry.indexOf('const requestedAudit')
  const quota = registry.indexOf('await this.quota.consume')
  return ownerGate >= 0 && ownerGate < preflight && preflight < requestedAudit && requestedAudit < quota
}

test('D1 source fixture pins every audited connector and its governance runner to local Git objects', () => {
  for (const snapshot of snapshots) {
    const resolvedRevision = gitAt(snapshot, ['rev-parse', '--verify', `${snapshot.revision}^{commit}`]).trim()
    assert.equal(resolvedRevision.startsWith(snapshot.revision), true, `${snapshot.name} revision does not resolve to its pinned commit`)
    assert.equal(gitBlobId(sourceAt(snapshot, snapshot.connectorPath)), snapshot.connectorBlob, `${snapshot.name} connector source changed from ${snapshot.revision}`)
    assert.equal(gitBlobId(sourceAt(snapshot, 'src/gcl/registry.ts')), snapshot.registryBlob, `${snapshot.name} runner source changed from ${snapshot.revision}`)
  }
})

test('D1 synthetic source closure has no egress, privileged configuration, subprocess, or send surface', () => {
  for (const snapshot of snapshots) {
    const connector = sourceAt(snapshot, snapshot.connectorPath)
    const closure = [...sourceClosure(snapshot).values()].join('\n')
    assert.match(connector, /LIVE_DISABLED/, `${snapshot.name} must declare a permanent disabled state`)
    assert.doesNotMatch(closure, /\b(?:fetch|XMLHttpRequest|WebSocket|axios|undici|node-fetch|https?\.request)\s*\(/, `${snapshot.name} must not introduce an egress client`)
    // SVG's non-network XML namespace is the sole allowed URL-shaped literal.
    assert.doesNotMatch(closure.replaceAll('http://www.w3.org/2000/svg', ''), /\bhttps?:\/\//, `${snapshot.name} must not embed a provider endpoint`)
    assert.doesNotMatch(closure, /\b(?:exec|execFile|spawn|fork|Bun\.spawn|Deno\.Command)\s*\(/, `${snapshot.name} must not launch a provider or local worker`)
    assert.doesNotMatch(closure, /(?:process\.env|environment)\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*/i, `${snapshot.name} must not read a credential-like environment variable`)
    assert.doesNotMatch(closure, /\b(?:autoPublish|automaticPublication)\s*:\s*true\b/, `${snapshot.name} must not automatically publish output`)
    const hasLiveEnableEnvironment = /GCL_[A-Z0-9_]+_LIVE_ENABLED/.test(connector)
    assert.equal(hasLiveEnableEnvironment, snapshot.hardDeniesLiveOptIn, `${snapshot.name} live-enable surface changed`)
    if (snapshot.hardDeniesLiveOptIn) assert.equal(hardDeniesLiveOptIn(connector), true, `${snapshot.name} must reject a true live flag`)
  }
})

test('D1 denied-owner and quota-rejection edge cases are classified without overstating conformance', () => {
  for (const snapshot of snapshots) {
    const registry = sourceAt(snapshot, 'src/gcl/registry.ts')
    assert.equal(ownerDenialPrecedesReservations(registry), true, `${snapshot.name} denied owner could reach preflight, audit reservation, or quota`)
    assert.equal(auditCapturesQuotaFailure(registry), snapshot.quotaFailureAudited, `${snapshot.name} quota-failure audit classification changed`)
  }
})
