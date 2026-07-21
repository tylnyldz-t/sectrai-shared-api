import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

type Snapshot = {
  name: string
  revision: string
  connectorPath: string
  connectorBlob: string
  registryBlob: string
  hardDeniesLiveOptIn: boolean
  quotaFailureAudited: boolean
}

/*
 * These are immutable, local Git objects from the D1 audit batch.  The test
 * reads them with `git show`; it does not import their runtime, load an env
 * file, open a socket, or make a network request.  A missing object is an
 * audit failure, not permission to silently skip the package.
 */
const snapshots: readonly Snapshot[] = [
  { name: 'RA voice', revision: '80a1cc6', connectorPath: 'src/gcl/voice.ts', connectorBlob: '1c232082a4bf8f6595afb2f6410f9f4d6c75fda0', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA OCR', revision: 'f6f28d7', connectorPath: 'src/gcl/vision.ts', connectorBlob: '13f4909cd4bf59425f68e92b8c3b73b10478f3ba', registryBlob: '3c50365d0713b025117af6cb95dafd08c371340f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA image', revision: '4d0806b', connectorPath: 'src/gcl/image.ts', connectorBlob: '224d9ef7d89b7d04f9df56e873b9a78bfe28da31', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA 3D/game', revision: '7e5b947', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '285decdf4809589cecdd727f27c31c6be1f918bc502ecd214'.slice(0, 40), registryBlob: '5638ef935dd727f27c31c6be1f918bc502ecd214', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'RA market', revision: '1b53141', connectorPath: 'src/gcl/market.ts', connectorBlob: '4b404e7d4737f324f74b3a8ca2386aa084a2b064', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { name: 'RFID', revision: '7b14d54', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '3c8d0cd1529f2dfd32f5e0e4ed18a2b59f96bd46', registryBlob: '73e2c802a9722f79d9a06acd085126a0835e5ae3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Translation', revision: '43541af', connectorPath: 'src/gcl/translation.ts', connectorBlob: '5e04a2a0656f5cf9b66dcfe153a73c5cb2721bc3', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Language education', revision: '2635230', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '386c4ab68fa0f1dfcb4d89e5213358ada0df3d89', registryBlob: 'b5a42f40fb070933dc6123665d38957e8e1df9c3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { name: 'Camera', revision: '0c166df', connectorPath: 'src/gcl/camera.ts', connectorBlob: '6682bf3b5b7ff73d14e3d1aed74a98ce2d32c63c', registryBlob: 'b8787e9af75503bb5b1b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
]

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function sourceAt(revision: string, path: string): string {
  return git(['show', '--no-textconv', `${revision}:${path}`])
}

function auditCapturesQuotaFailure(registry: string): boolean {
  const requestedAudit = registry.indexOf('const requestedAudit')
  const quota = registry.indexOf('await this.quota.consume', requestedAudit)
  const protectedExecution = registry.indexOf('try {', requestedAudit)
  const failureAudit = registry.indexOf("type: 'connector.run.failed'", quota)
  return requestedAudit >= 0 && quota > requestedAudit && protectedExecution > requestedAudit && protectedExecution < quota && failureAudit > quota
}

test('D1 source fixture pins every audited connector and its governance runner', () => {
  for (const snapshot of snapshots) {
    assert.equal(git(['rev-parse', `${snapshot.revision}:${snapshot.connectorPath}`]), snapshot.connectorBlob, `${snapshot.name} connector source changed`)
    assert.equal(git(['rev-parse', `${snapshot.revision}:src/gcl/registry.ts`]), snapshot.registryBlob, `${snapshot.name} runner source changed`)
  }
})

test('D1 synthetic boundary has no egress surface and hard-denies every live opt-in it exposes', () => {
  for (const snapshot of snapshots) {
    const connector = sourceAt(snapshot.revision, snapshot.connectorPath)
    assert.match(connector, /LIVE_DISABLED/, `${snapshot.name} must declare a permanent disabled state`)
    assert.doesNotMatch(connector, /\bfetch\s*\(/, `${snapshot.name} must not introduce an HTTP client`)
    assert.doesNotMatch(connector, /\bhttps?:\/\//, `${snapshot.name} must not introduce a provider URL`)
    const hasLiveEnableEnvironment = /GCL_[A-Z0-9_]+_LIVE_ENABLED/.test(connector)
    assert.equal(hasLiveEnableEnvironment, snapshot.hardDeniesLiveOptIn, `${snapshot.name} live-enable surface changed`)
    if (snapshot.hardDeniesLiveOptIn) assert.match(connector, /if \(this\.config\.liveEnabled\) throw new ConnectorUnavailableError/, `${snapshot.name} must reject a true live flag`)
  }
})

test('D1 quota-rejection edge case is classified without overstating conformance', () => {
  for (const snapshot of snapshots) {
    const registry = sourceAt(snapshot.revision, 'src/gcl/registry.ts')
    assert.equal(auditCapturesQuotaFailure(registry), snapshot.quotaFailureAudited, `${snapshot.name} quota-failure audit classification changed`)
  }
})
