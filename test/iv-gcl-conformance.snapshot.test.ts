import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

type AuditBatch = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9' | 'D10' | 'D11' | 'D12' | 'D13' | 'D14' | 'D15' | 'D16' | 'D17' | 'D18' | 'D19' | 'D20' | 'D21'

type PinnedClosureBlob = {
  path: string
  blob: string
}

/**
 * A package-level GCL module changed while its public connector and runner
 * remained stable. It is an additional audited root, so its own local import
 * closure receives the same fail-closed source scan.
 */
type PinnedSupplementalBlob = {
  path: string
  blob: string
}

type Snapshot = {
  batch: AuditBatch
  name: string
  revision: string
  /** When supplied, this snapshot must be the exact direct Git child of it. */
  parentRevision?: string
  directory: string
  connectorPath: string
  connectorBlob: string
  registryBlob: string
  hardDeniesLiveOptIn: boolean
  quotaFailureAudited: boolean
  /** A truthy runtime value must not substitute for an explicit owner approval. */
  strictOwnerApproval?: boolean
  /** A Proxy array must be rejected before an intrinsic Array inspection can throw. */
  proxyArrayIngressSafe?: boolean
  /** A package module gets an exact blob pin in addition to its closure scan. */
  pinnedClosureBlobs?: readonly PinnedClosureBlob[]
  /** A package companion requires review even when it is not imported by the public connector. */
  pinnedSupplementalBlobs?: readonly PinnedSupplementalBlob[]
}

const AUDIT_WORKTREE_ROOT = '/home/tayla/projects/_wt'
const GCL_ROOT = 'src/gcl/'
/** `node:util` is limited to in-process Proxy detection in Camera and RA market. */
const ALLOWED_NONLOCAL_GCL_IMPORTS = new Set(['node:crypto', 'node:util'])
/** Prisma is permitted only as an erased TypeScript type import in the local persistence seam. */
const ALLOWED_TYPE_ONLY_GCL_IMPORTS = new Set(['@prisma/client'])

/*
 * These are immutable local Git snapshots from the D1 through D21 audit batches.
 * Every source read below is `git show <revision>:<path>`, never the mutable
 * worktree file. This fixture does not import target runtime code, load an
 * env file, open a socket, or make a network request. A missing worktree,
 * revision, blob, or local GCL dependency is an audit failure.
 */
const snapshots: readonly Snapshot[] = [
  { batch: 'D1', name: 'RA voice', revision: '80a1cc6', directory: 'night-ra-voice', connectorPath: 'src/gcl/voice.ts', connectorBlob: '1c232082a4bf8f6595afb2f6410f9f4d6c75fda0', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'RA OCR', revision: 'f6f28d7', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '13f4909cd4bf59425f68e92b8c3b73b10478f3ba', registryBlob: '3c50365d0713b025117af6cb95dafd08c371340f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'RA image', revision: '4d0806b', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '224d9ef7d89b7d04f9df56e873b9a78bfe28da31', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'RA 3D/game', revision: '7e5b947', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '285decdf4809589cecdd3cb9462995b885491f2b', registryBlob: '5638ef935dd727f27c31c6be1f918bc502ecd214', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'RA market', revision: '1b53141', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '4b404e7d4737f324f74b3a8ca2386aa084a2b064', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D1', name: 'RFID', revision: '7b14d54', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '3c8d0cd1529f2dfd32f5e0e4ed18a2b59f96bd46', registryBlob: '73e2c802a9722f79d9a06acd085126a0835e5ae3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'Translation', revision: '43541af', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '5e04a2a0656f5cf9b66dcfe153a73c5cb2721bc3', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'Language education', revision: '2635230', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '386c4ab68fa0f1dfcb4d89e5213358ada0df3d89', registryBlob: 'b5a42f40fb070933dc6123665d38957e8e1df9c3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D1', name: 'Camera', revision: '0c166df', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '6682bf3b5b7ff73d14e3d1aed74a98ce2d32c63c', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D2', name: 'RA OCR', revision: 'b8d9505', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '6d961acd25697df35e959464bd9b3cd4a4286855', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D2', name: 'RA image', revision: 'ee498bf', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '78c53279452694984f4e52c31b1f970c1fb5f650', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D2', name: 'RA 3D/game', revision: 'e896365', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'ea48c3b8c6ec5af5dfa397babf435e6fd58e7155', registryBlob: '456adc6932ad1de226a5a9b2db16ce522697cf2f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D2', name: 'RA market', revision: 'e20e176', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'e1fdb17ba9a9df8d18b8e3e61978ec60769d9ee6', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D2', name: 'RFID', revision: '14f069a', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '2fdfd6b87da5ed330b0e5fb9ad45afac4f34114f', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D2', name: 'Translation', revision: 'eff19c3', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '5e04a2a0656f5cf9b66dcfe153a73c5cb2721bc3', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D2', name: 'Camera', revision: '9a3841a', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'ee9d8a8c6a2d90ab99de2d8e34cf1b9404912867', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D3', name: 'RA OCR', revision: '27e4828', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '22c5c461e42eecfd263f465345d69d85c83ec91a', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D3', name: 'RA image', revision: '6c13d06', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'b97327df5d7bb2d6dc9ebc58bdb9ab91a1f946f4', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D3', name: 'RA 3D/game', revision: '55df54f', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'c9917936e8b6351ec5a08c26631e4c9dbd89f9db', registryBlob: '456adc6932ad1de226a5a9b2db16ce522697cf2f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D3', name: 'RA market', revision: '3f4aae8', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'b8689611cde92120393f44d9c53945edcdaa082d', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D3', name: 'RFID', revision: '275cef6', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '2fdfd6b87da5ed330b0e5fb9ad45afac4f34114f', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D3', name: 'Translation', revision: '32cf3d0', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4bf8b862b22ddb9e0aaeff25f62e3f00123a9345', registryBlob: 'bde353ad8e3896800b3d3d5da4660480719c5aea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D3', name: 'Language education', revision: '3492a3b', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'ada424023ebfd3cc60a0e816d6a1b1ea1ba6395d', registryBlob: '1c57c070aa37148134e21310aa258857c5500687', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D3', name: 'Camera', revision: 'dd36dfe', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '74c0a98c8dcfdbdc9318b1e9db20aa01654593bb', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D4', name: 'RA OCR', revision: '1a16536', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '5b4adee8ab4a4bed906e15fbb278c655c4a24812', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D4', name: 'RA image', revision: '3e4c5cf', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '1d200a521cefba57deebdc9a6e93ee111b2e4b25', registryBlob: '15032539e2733a12714d1bd6ab769c5ff6d648ea', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D4', name: 'RA 3D/game', revision: 'e850715', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'f59147541487c13e064de92fc2a095f36d3b5889', registryBlob: '456adc6932ad1de226a5a9b2db16ce522697cf2f', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D4', name: 'RA market', revision: '6ab0345', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '83db97334995c3b29442644ca131ff82e133a98f', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D4', name: 'RFID', revision: 'ee3627a', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '217949f40bf5565fb2f53427fcc18d5d8a00b83a', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D4', name: 'Translation', revision: '18a6188', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4bf8b862b22ddb9e0aaeff25f62e3f00123a9345', registryBlob: 'd946ce74ecf0a10b77fcfb584b34fe99ab8395c3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D4', name: 'Language education', revision: '5a16014', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '1a84c98cd3183e6ba60f55b9b1c53b8ff0159142', registryBlob: '1c57c070aa37148134e21310aa258857c5500687', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D4', name: 'Camera', revision: '1102d32', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'cee7f14571281122917ae038704d6f995e809f99', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D5', name: 'RA OCR', revision: '1540e2e', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '7cb3bffcee754b3b7b3168214cfd9e483599d96e', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D5', name: 'RA image', revision: 'e0bbd31', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '2ad02996fa62777794af149e3e0879354ac3e90c', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D5', name: 'RA 3D/game', revision: '1e3edc2', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '6e12d3a0d04a72df47f92d248ad5277ca8c9c102', registryBlob: 'd39c1a771ccacb0a13b354626fc054bdeca113f2', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D5', name: 'RA market', revision: 'd9a7677', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '7a63111faefa0e879f8cffb983cdfc3660f4104c', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D5', name: 'RFID', revision: '146539a', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '4dc6d48c4c6b8d7dcad424e080c3db2f47d583fa', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D5', name: 'Translation', revision: 'cc63f92', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4bf8b862b22ddb9e0aaeff25f62e3f00123a9345', registryBlob: 'f8ba8b74b1c8945d5ff26a32de776a25cd5221a3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D5', name: 'Language education', revision: 'f1dff88', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '73ae75585a82ec7734c1d3da52bedd48d0a2ef4d', registryBlob: '1c57c070aa37148134e21310aa258857c5500687', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D5', name: 'Camera', revision: '9228cd5', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '864abf2b2902d3512d630473ee88c9d111f7391d', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D6', name: 'RA OCR', revision: '4b2f349', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'd455b2554791b220f03e2490949c48430a546229', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D6', name: 'RA image', revision: '23de86d', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '9c01996fd63c3d93f2b705c02a492a9395df119e', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D6', name: 'RA 3D/game', revision: 'ee6a69b', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '6e12d3a0d04a72df47f92d248ad5277ca8c9c102', registryBlob: 'd39c1a771ccacb0a13b354626fc054bdeca113f2', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: '85c33bd53000820ba7399457dd22af0b4d509c75' }] },
  { batch: 'D6', name: 'RA market', revision: '619c34c', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '2748df68731ca5b1df113f6e9b22cffad1e5cf09', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D6', name: 'RFID', revision: '9ea5603', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '079aed352d860810b5667b0b037237eac511663c', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D6', name: 'Translation', revision: '00ab942', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D6', name: 'Language education', revision: '4b6170b', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '64f7066c7d73d4eb1ca5fa956950be4f2be5f71a', registryBlob: '1c57c070aa37148134e21310aa258857c5500687', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D6', name: 'Camera', revision: '295dc3e', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'a71c91d36398d081b4d5b37cad17164db142e933', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D7', name: 'RA OCR', revision: '62ed9eb', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '30bca19f3c8412c63d1c42b1648a353185df5acb', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D7', name: 'RA 3D/game', revision: 'b7e68b9', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'fa905dd4315a8e716802fea24e72887ced834242', registryBlob: '384f768b9b28a244ca64aa2ebddb959decd5ec8c', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: '2fcb35bda06524eb9c1f1c31f1c080eab1b59461' }] },
  { batch: 'D7', name: 'RA market', revision: 'ee6209a', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '5acec2955a39300dc2a6c37b2a5de39b6398857a', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D7', name: 'RFID', revision: 'a3ab022', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '17dd14239097629b78eef8a523c61978acc277b9', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D7', name: 'Translation', revision: 'c5ce740', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '5ed64f5eb137e69c614fab7632d3d5c80b43f6bb' }, { path: 'src/gcl/translation-artifacts.ts', blob: '57c9e99c98a932d0ae1c4efde03e2762126322e4' }] },
  { batch: 'D7', name: 'Camera', revision: 'f0a524c', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '06c7d713ed66b80139436e27e46f9637a2cc0825', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D8', name: 'RA OCR', revision: '86f8055', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'cf55a607c4ceefac204cb90c881fec0e6216b328', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D8', name: 'RA image', revision: '04b945d', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '88618cf02fad7fdd484358d157c9dd87992ec01c', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/image-candidate-ledger.ts', blob: '0d6cdddb6292c4172d38137c6f99e2da079343d7' }] },
  { batch: 'D8', name: 'RA 3D/game', revision: '986fd50', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '89c26246bff92af76ee50f28b25aeac53d326a40', registryBlob: '384f768b9b28a244ca64aa2ebddb959decd5ec8c', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'ba5a80dc6c255cbea66b9a1813df1b17077fb13b' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: 'c8e9711e9604272486ce2353a1eb9a3424a8742c' }] },
  { batch: 'D8', name: 'RA market', revision: 'bd75c31', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '1d3db9ffd0f47fd2383389e0fa980df40c19bd7e', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/market-review-ledger.ts', blob: '7ff009bc87e25cc7fb4017cb7a1a9f3cfc261b83' }] },
  { batch: 'D8', name: 'RFID', revision: '89889f7', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '7878aed832361912db5ec31464f20f36ef4d0269', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D8', name: 'Translation', revision: 'c9094d7', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '9354ab43694a6e9e21036c9c92fcf433c6bef784' }, { path: 'src/gcl/translation-artifacts.ts', blob: '37422b5aba1786d8cce4d0dae40875bf6d3421a0' }] },
  { batch: 'D8', name: 'Language education', revision: 'df82e56', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'a79fef5d49912bd91a33bd4d53f2fdaaeacc7c39', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'ae74185cb5ec48eccc892f7d1100431d9104f1b1' }] },
  { batch: 'D8', name: 'Camera', revision: '7420369', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'b23dd98c3bbfa2dcf006b1ff8385204be295873b', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D9', name: 'RA OCR', revision: '53043fb', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '913eb396f8d38a7ed27ab00aa221291e5c06072c', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D9', name: 'RA image', revision: '21282f1', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '88618cf02fad7fdd484358d157c9dd87992ec01c', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '89e07bf0f24368950086547b8af570e13234d9dd' }] },
  { batch: 'D9', name: 'RA 3D/game', revision: '504a4ce', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '066b62c8626154da88ca3c01cb5f04cd11f95a72', registryBlob: '384f768b9b28a244ca64aa2ebddb959decd5ec8c', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/plan-integrity.ts', blob: '4de14f848029e869f47ebbbea6245c4bd591d0ed' }, { path: 'src/gcl/result-boundary.ts', blob: '0b7425db4d325c9d403342a2f2d0e475133ec609' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: 'cc4ac8e9f77571841f16e88ac3f694338c374e40' }] },
  { batch: 'D9', name: 'RA market', revision: 'a373b48', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'b3528e927b8ab56f02705a311811c7574513e82a', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D9', name: 'RFID', revision: 'fb59cc0', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '68c6bf5e4d1857e7b9cc666f37c2a0213be7d65e', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D9', name: 'Translation', revision: 'ab6f765', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '0ee763928b9ebf74ccc3bf45defef10b80eae699' }, { path: 'src/gcl/translation-artifacts.ts', blob: '0c7b6a3224e5ebd384caf31fb932882b426da3cd' }] },
  { batch: 'D9', name: 'Language education', revision: 'f7744fe', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '3c14fd5db26020ffe17234f61ca1d2e8db08ab6e', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '59bb579cd9764e12e926c996e0f317e86145f203' }] },
  { batch: 'D9', name: 'Camera', revision: 'e0f54f0', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '65f976c1099167166463487bcc2e01f63c7ef583', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D10', name: 'RA OCR', revision: '1b50843', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '4ed8df17ba01bf80f3c9ae4fac61afc34c809003', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D10', name: 'RA image', revision: 'f2f2c10', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '88618cf02fad7fdd484358d157c9dd87992ec01c', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D10', name: 'RA 3D/game', revision: '46a631e', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '066b62c8626154da88ca3c01cb5f04cd11f95a72', registryBlob: '9b317ca768bfb32d43acb66ce86abadb71debcd5', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D10', name: 'RA market', revision: 'a0142f6', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'b1ea29fa686e957d8b7f05e802a11d50c31ba19d', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D10', name: 'RFID', revision: 'd942746', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '68c6bf5e4d1857e7b9cc666f37c2a0213be7d65e', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D10', name: 'Translation', revision: '6f34b55', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'cb6b2a1329d4fa85ecf69fc8f3282dc2c0dfdeeb' }] },
  { batch: 'D10', name: 'Language education', revision: 'e9baa02', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '5ed6ce490238a24a808074bd9e8a298c58cb42a8', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '9b51dfaafc9ce5db4ef0313d556bf47c9a1f8c1a' }] },
  { batch: 'D10', name: 'Camera', revision: '3f5202b', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '0f8779b81972e76c15389b25fa52b8b011da4f41', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D11', name: 'RA OCR', revision: '536ac02', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '4ed8df17ba01bf80f3c9ae4fac61afc34c809003', registryBlob: '684026b637562c2b820bc7c4ae49d5a2b4bb4598', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D11', name: 'RA image', revision: '18196ad', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'e0a1cd4c2707b6dfc6c15aa0d0b1647e89b4ffe8', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: 'f1618239ae09978cbaa079c13bccb3a028fbbef5' }, { path: 'src/gcl/image-candidate-ledger.ts', blob: '58cb439da487d85f947aa622dc677f9879f075fd' }] },
  { batch: 'D11', name: 'RA 3D/game', revision: '2e05cf1', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '066b62c8626154da88ca3c01cb5f04cd11f95a72', registryBlob: '9b317ca768bfb32d43acb66ce86abadb71debcd5', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D11', name: 'RA market', revision: '424a2cc', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'c8a2936c3c424c702db8ae5cd2409bab203ac32b', registryBlob: '4df08cd04321797b8522029a4754926f4fa715df', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D11', name: 'RFID', revision: 'fc1f4c2', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: 'f57552c9506583ef01b55b5a051666e37a8bf007', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D11', name: 'Translation', revision: 'e7146d1', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'f981309efe34aaec9df537146e2c6924dc6db9e8' }] },
  { batch: 'D11', name: 'Language education', revision: '5dad6ba', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '5ed6ce490238a24a808074bd9e8a298c58cb42a8', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D11', name: 'Camera', revision: '71d5779', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '0f8779b81972e76c15389b25fa52b8b011da4f41', registryBlob: 'b8787e9af75503bb5b1f5b0c8269545846dfaa95', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D12', name: 'RA OCR', revision: '420a039', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'ef24e6ff8e83cfbcac6d43b2f5405825f3e44049', registryBlob: '7fb5b5e5ece8b9442423bd49eb38db978b6371ab', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D12', name: 'RA image', revision: '86a2582', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '33d0ecbde9345e8d4c6683342e5011ee04bda5e8', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/image-candidate-ledger.ts', blob: 'cf9b264e070602028d2ae94bf7c8aa0923930165' }, { path: 'src/gcl/image-review-ledger.ts', blob: 'c7f078c2c831d2231626f566bf033d14dca71531' }] },
  { batch: 'D12', name: 'RA 3D/game', revision: '31d3052', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '59cbc705c64fd856c2eccae8842bc2aac307e782', registryBlob: '9b317ca768bfb32d43acb66ce86abadb71debcd5', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/jnc-pilot.ts', blob: 'ed77b9715a54b38eddf56691f0432ccc0a4c28a6' }, { path: 'src/gcl/result-boundary.ts', blob: 'b3e407331974122741cb4ab578d651c1fe8db6ff' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: '5654a2a3e92462209742948e28ec2fe47f6bdb03' }] },
  { batch: 'D12', name: 'RA market', revision: 'c64c310', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '11636d2d9a96d8e1662e66324430120c77428308', registryBlob: '66f1a5872dd8ccad258fceb833476f46e9a373c8', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D12', name: 'RFID', revision: 'a7fa389', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: 'efbdc7237dbc3bb34da40960878e45ead685a75b', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D12', name: 'Translation', revision: 'af3be75', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '362e0dd89efe2ebfc735b9f88693736f3a8ee8d3' }, { path: 'src/gcl/translation-artifacts.ts', blob: 'b3a30c025ce226fb80dfb5ef4c37a163d3454487' }, { path: 'src/gcl/translation-artifact-review.ts', blob: 'b0f485a6542ffeb245f0811ebf858d8dd8d584b2' }] },
  { batch: 'D12', name: 'Language education', revision: '5d10f3f', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '77f7d4544eba690ea7ae2b61b5b83c81cd474a8b', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'cffd9481bcc2e4ddb02bec7f87c57d4a6e5dd6f5' }] },
  { batch: 'D12', name: 'Camera', revision: '9660feb', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '0f8779b81972e76c15389b25fa52b8b011da4f41', registryBlob: '01d5bbfb071b806d4c6ba77fa5974fc838c0febc', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D13', name: 'RA OCR', revision: 'e87610c', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'ef24e6ff8e83cfbcac6d43b2f5405825f3e44049', registryBlob: '7fb5b5e5ece8b9442423bd49eb38db978b6371ab', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D13', name: 'RA image', revision: '1c08de7', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'c9b576bbd2051fa0c22f69fb1e8f16bd69b63ed3', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D13', name: 'RA 3D/game', revision: '48117da', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'ab9ef5e2b668ff176c6f2aff708479b8b367fcbb', registryBlob: 'e2c97f4be56ae7db01c18c5fa33ed0d3f51a8297', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'd9614e917857e448ad868089084c73261d1dbd4a' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: 'bdd208d9870aeb460fb50ba8e817eba62b4c4195' }] },
  { batch: 'D13', name: 'RA market', revision: 'f2caeb2', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '11636d2d9a96d8e1662e66324430120c77428308', registryBlob: '66f1a5872dd8ccad258fceb833476f46e9a373c8', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D13', name: 'RFID', revision: 'a6f5939', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: 'be65336fc3e07219c960db748112ac29ad68738e', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D13', name: 'Translation', revision: '8bf4882', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D13', name: 'Language education', revision: '60b6797', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '77f7d4544eba690ea7ae2b61b5b83c81cd474a8b', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D13', name: 'Camera', revision: '91ad591', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'e6383011823344a3bd28b001da1bcf8e0f0c8901', registryBlob: '4a07eadfc9a9d42418547387bd8d7bc6575290b9', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D14', name: 'RA OCR', revision: 'ff0fb55', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '0705f10d5c026fb592f7c0a949313bf61a5d3cb3', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D14', name: 'RA image', revision: '33c53f3', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '34ec0d7bcb615775f8576dba603707fac683e3b5', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/image-candidate-ledger.ts', blob: 'bee9b5b184782dc5773adc2c52dd5658020558dc' }, { path: 'src/gcl/image-review-ledger.ts', blob: '1a496e0ee150b3c3a864c044e498b457cc27c6b3' }] },
  { batch: 'D14', name: 'RA 3D/game', revision: '63c793a', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '33880bb20846f1a1ad1b6c064dd499514b966d82', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'c9e9718d150c13419b5b5d60391145c38d94a4b9' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: 'dd012c3eab154a1763faa04d80dba9f964518f10' }] },
  { batch: 'D14', name: 'RA market', revision: '89b9175', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '11636d2d9a96d8e1662e66324430120c77428308', registryBlob: '63a7ec54de0a798bbeca9f7da9577fb701495b4b', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D14', name: 'RFID', revision: '80e8a7a', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: 'be65336fc3e07219c960db748112ac29ad68738e', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D14', name: 'Translation', revision: 'b9a510c', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'ec19515a62257f017678092dcbacab493387b3d8' }, { path: 'src/gcl/translation-artifacts.ts', blob: '3c94e009008116e709c947e0b43140aed9c7f2b9' }] },
  { batch: 'D14', name: 'Language education', revision: '24b3c4a', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'c8a83355a2f6a468b3443cc56121b416f859ac12', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'be5f2d160d16f27f1d3edda58cce044a011a62d5' }] },
  { batch: 'D14', name: 'Camera', revision: '2359558', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '539d5df89194e0326810789d2b2255386a592108', registryBlob: 'addf058761d48e2da8d0664137c68e6d460fb456', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D15', name: 'RA OCR', revision: 'f8a4a85', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '76140e91ee58ed485f1b8f331e62faa68a5f1879', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D15', name: 'RA image', revision: 'd0016de', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'bf63ec84ac4f49d2a96be90c30b77b186e065cae', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/image-review-ledger.ts', blob: '288fda9cf212001b6dca0b0835981bb8d1964728' }] },
  { batch: 'D15', name: 'RA 3D/game', revision: '8ec75f6', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: '1c6d4b6668a14b0a0acc6f5fc82bd1b4347aeab5', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: '5d7c08247cfb20786705ff2af635cf146c9fb708' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: '68a7fa57fe52a436bf394d29b5992944586c5f23' }] },
  { batch: 'D15', name: 'RA market', revision: 'd1b4b97', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '11636d2d9a96d8e1662e66324430120c77428308', registryBlob: '9fa4810c5ef2d68814dcccb600cdf88c5835e557', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D15', name: 'RFID', revision: 'c793243', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '1074f61a637426e47934c90e009357531a335fb9', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D15', name: 'Translation', revision: '9144977', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '542a39d3ac9849469d5a39aca21dd60a58ec374a', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'ec19515a62257f017678092dcbacab493387b3d8' }, { path: 'src/gcl/translation-artifacts.ts', blob: '3c94e009008116e709c947e0b43140aed9c7f2b9' }] },
  { batch: 'D15', name: 'Language education', revision: '77b805a', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'c8a83355a2f6a468b3443cc56121b416f859ac12', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'be5f2d160d16f27f1d3edda58cce044a011a62d5' }] },
  { batch: 'D15', name: 'Camera', revision: '3a127ae', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'd01cd7b19acf975a09c9d51e75e66df5e41a6a80', registryBlob: 'fb46d9f3271e79b1966cdffa075bde325cb56e8d', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/errors.ts', blob: '7e373dce7b114770be1c05f5de61dff1f067bebc' }] },
  { batch: 'D16', name: 'RA OCR', revision: '2d4c78c', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '76140e91ee58ed485f1b8f331e62faa68a5f1879', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D16', name: 'RA image', revision: '16b4689', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'bf63ec84ac4f49d2a96be90c30b77b186e065cae', registryBlob: '76221dc13d588bd7a042735badf6bc825b573ca3', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D16', name: 'RA 3D/game', revision: 'f2efd6b', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'e30cf1d4f158e6d1b2a98a9073061c43362b18c7', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: '7acc391722d5b43c0922e8bcc4b127ac28fdee8d' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/game-engine.ts', blob: '7561bde35dea24f32821a77e87999101f8df73d6' }] },
  { batch: 'D16', name: 'RA market', revision: '6fa3a80', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '39451c140ad97b426dbcc76d0793506a84788335', registryBlob: '9fa4810c5ef2d68814dcccb600cdf88c5835e557', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D16', name: 'RFID', revision: '7633dd7', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '688d170d830684e8c0dfd35f0d480ea7d81e4019', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D16', name: 'Translation', revision: '8911290', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '46280bb34960ee1ae5794bd8ee952ccfc1262708', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D16', name: 'Language education', revision: 'a8d986d', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'c016c22ff9c9dc8fd017e18b5c237f173ce9b6f5', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '3736c0bb4c56981efa81641ae94d0595a5030a9f' }] },
  { batch: 'D16', name: 'Camera', revision: 'fe57460', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: 'd01cd7b19acf975a09c9d51e75e66df5e41a6a80', registryBlob: 'fb46d9f3271e79b1966cdffa075bde325cb56e8d', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D17', name: 'RA OCR', revision: '3ff9d1d', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '8fda0ba56946d74fb389aaa57e7f8e9aa4834963', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false },
  { batch: 'D17', name: 'RA image', revision: '2e021b3', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'bf63ec84ac4f49d2a96be90c30b77b186e065cae', registryBlob: '6faf3cd1be37336d7cdc4181a81d90199aa2e9a2', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D17', name: 'RA 3D/game', revision: 'a9dbbe6', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'eccfc749f420702b6c7f206f72d54241a71ce05d', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: '10c43280de0db030e79348bcf0026dea6255bd52' }] },
  { batch: 'D17', name: 'RA market', revision: 'f501388', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '39451c140ad97b426dbcc76d0793506a84788335', registryBlob: '9fa4810c5ef2d68814dcccb600cdf88c5835e557', hardDeniesLiveOptIn: true, quotaFailureAudited: false },
  { batch: 'D17', name: 'RFID', revision: '7ee3b11', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '688d170d830684e8c0dfd35f0d480ea7d81e4019', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true },
  { batch: 'D17', name: 'Translation', revision: 'a57b677', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '4c983a29f07983652be61f3c948e823eb9492422', registryBlob: '46280bb34960ee1ae5794bd8ee952ccfc1262708', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '3bc0b92de9e503f6f0d4a4384e619776ab6cff74' }] },
  { batch: 'D17', name: 'Language education', revision: '7f21473', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'c016c22ff9c9dc8fd017e18b5c237f173ce9b6f5', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true },
  { batch: 'D17', name: 'Camera', revision: '1adcf01', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '41e83266ea7f68a06fdf3220137943c4276abb47', registryBlob: '5fc1d513d6ade75defca073e34c2a7d6cd92ee50', hardDeniesLiveOptIn: true, quotaFailureAudited: true, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: 'f1d877895b7ba805b3359a40cdd6e76b3c36bf24' }, { path: 'src/gcl/errors.ts', blob: '0cb36107c3f6844d399c7fe1a11f71b07b2a0951' }] },
  { batch: 'D18', name: 'RA OCR', revision: 'a9e040a', parentRevision: '3ff9d1d', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '6fa36ca1fe83aaee1bb15d97cf2a256e35a67b95', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: false, proxyArrayIngressSafe: false },
  { batch: 'D18', name: 'RA image', revision: '111bcb8', parentRevision: '2e021b3', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: 'bf63ec84ac4f49d2a96be90c30b77b186e065cae', registryBlob: '6faf3cd1be37336d7cdc4181a81d90199aa2e9a2', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: true },
  { batch: 'D18', name: 'RA 3D/game', revision: 'f3dd0b9', parentRevision: 'a9dbbe6', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'eccfc749f420702b6c7f206f72d54241a71ce05d', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'cf6127caa4fb7549a73f92acdff69e6d7d7cf172' }] },
  { batch: 'D18', name: 'RA market', revision: '441f4b7', parentRevision: 'f501388', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: 'b9fa623e97bc2913955ed6993b6e1ba51ac70966', registryBlob: '1221f840ebab9e1cb893c22b799eb257222dd9de', hardDeniesLiveOptIn: true, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'af015f263316247e31302ae615ae02cef03d06f0' }] },
  { batch: 'D18', name: 'RFID', revision: '9fb39bb', parentRevision: '7ee3b11', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: 'cf77ae105725ef7b9580afd4e0faf745547d16de', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D18', name: 'Translation', revision: '564b7b0', parentRevision: 'a57b677', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '8b614f48e48dea12b2ea94b1d7ab3565f19b297d', registryBlob: '34e9d79cf1a748e63c2b0de8ac65d351e2339c21', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D18', name: 'Language education', revision: 'c297207', parentRevision: '7f21473', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '3999b859dd5aec06000563f679634bd50a44ca36', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '3880778017fa930b58dee48e4a45af2b755ce607' }] },
  { batch: 'D18', name: 'Camera', revision: '7591c86', parentRevision: '1adcf01', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '41e83266ea7f68a06fdf3220137943c4276abb47', registryBlob: '5fc1d513d6ade75defca073e34c2a7d6cd92ee50', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: 'f1d877895b7ba805b3359a40cdd6e76b3c36bf24' }, { path: 'src/gcl/errors.ts', blob: '0cb36107c3f6844d399c7fe1a11f71b07b2a0951' }] },
  { batch: 'D19', name: 'RA OCR', revision: 'eb36d81', parentRevision: 'a9e040a', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'fe770fb5d1269d033ad47956a193b0ded5f3b5f4', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: false, proxyArrayIngressSafe: true },
  { batch: 'D19', name: 'RA image', revision: '9b6917c', parentRevision: '111bcb8', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '57ad4a906b2012c9802fd454787490b5db637b22', registryBlob: 'adebd1bde90230779827b9ee05d1d5f5507eda83', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: true },
  { batch: 'D19', name: 'RA 3D/game', revision: '4723124', parentRevision: 'f3dd0b9', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'eccfc749f420702b6c7f206f72d54241a71ce05d', registryBlob: '400933ad278d07687541967370fae5ef584abbc9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'cf6127caa4fb7549a73f92acdff69e6d7d7cf172' }] },
  { batch: 'D19', name: 'RA market', revision: '3b88237', parentRevision: '441f4b7', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '2c0a63b87899d0898343035db6118afd03bd680c', registryBlob: '1221f840ebab9e1cb893c22b799eb257222dd9de', hardDeniesLiveOptIn: true, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'af015f263316247e31302ae615ae02cef03d06f0' }] },
  { batch: 'D19', name: 'RFID', revision: 'c536f84', parentRevision: '9fb39bb', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '944e4dad8c2748457117e9b75a689c8c1fb5064c', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D19', name: 'Translation', revision: '946871b', parentRevision: '564b7b0', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: '8b614f48e48dea12b2ea94b1d7ab3565f19b297d', registryBlob: '34e9d79cf1a748e63c2b0de8ac65d351e2339c21', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D19', name: 'Language education', revision: '2b402f7', parentRevision: 'c297207', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '3999b859dd5aec06000563f679634bd50a44ca36', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '3880778017fa930b58dee48e4a45af2b755ce607' }] },
  { batch: 'D19', name: 'Camera', revision: '76f2aed', parentRevision: '7591c86', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '4da642cc6a84c9ff7adc17ea24d2a4eb4b8a447f', registryBlob: '633e26032a418652da915acd7fbed52692258b36', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: '72193782aa6b5a84ec7ad957367838f3facb4ee7' }, { path: 'src/gcl/errors.ts', blob: 'b6965423162ee86f72bcb1d4dfcdb29b30e55a52' }] },
  { batch: 'D20', name: 'RA OCR', revision: 'c1d330c', parentRevision: 'eb36d81', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: 'd4604192e24c7f8562c9ac4e49e7fa3c3f3341aa', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: false, proxyArrayIngressSafe: true },
  { batch: 'D20', name: 'RA image', revision: '988c41b', parentRevision: '9b6917c', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '57ad4a906b2012c9802fd454787490b5db637b22', registryBlob: 'adebd1bde90230779827b9ee05d1d5f5507eda83', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: true },
  { batch: 'D20', name: 'RA 3D/game', revision: 'e2aca2f', parentRevision: '4723124', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'eccfc749f420702b6c7f206f72d54241a71ce05d', registryBlob: '0dcac2afddd3e6f133481f8b3735aa7ef8d2ffbc', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'cf6127caa4fb7549a73f92acdff69e6d7d7cf172' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '76cdd57b2bfaf434afbb5d5f8f9f4ba50ee36f55' }] },
  { batch: 'D20', name: 'RA market', revision: '9b993a6', parentRevision: '3b88237', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '6f25a2e074fbfe963e478da767bde91c001ed6aa', registryBlob: '1221f840ebab9e1cb893c22b799eb257222dd9de', hardDeniesLiveOptIn: true, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'af015f263316247e31302ae615ae02cef03d06f0' }] },
  { batch: 'D20', name: 'RFID', revision: '5727465', parentRevision: 'c536f84', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '944e4dad8c2748457117e9b75a689c8c1fb5064c', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D20', name: 'Translation', revision: '2443f1d', parentRevision: '946871b', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: 'c0bf86902ed32af1b65352ad4fc6f891916db859', registryBlob: '34e9d79cf1a748e63c2b0de8ac65d351e2339c21', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: false, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'c0206818c4ed80290314bf5cdeab09580582dfdb' }] },
  { batch: 'D20', name: 'Language education', revision: 'a48bd08', parentRevision: '2b402f7', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: '85e851b2b208a3599dc6adb526385c49014834d8', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '237e8ba6883594baaff2492036ed05b23d53b390' }] },
  { batch: 'D20', name: 'Camera', revision: '79f758c', parentRevision: '76f2aed', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '026b562153205103028e0eb36ca12350869f9995', registryBlob: '73ca0e2e92278d64dc4f74c339a8875481a5d663', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: '6ba529e7abaf06a29677f3724316cb75d4818d48' }, { path: 'src/gcl/errors.ts', blob: 'd91f8939d3d63d76aa016b1957e717a740fce5f4' }] },
  { batch: 'D21', name: 'RA OCR', revision: '361c978', parentRevision: 'c1d330c', directory: 'night-ra-ocr', connectorPath: 'src/gcl/vision.ts', connectorBlob: '8d73725aeca31e8f69b68883ae2468ef456fcec8', registryBlob: '2407ff38734546832bd9a8e2e97fae488198e7f9', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: false, proxyArrayIngressSafe: true },
  { batch: 'D21', name: 'RA image', revision: 'a68c433', parentRevision: '988c41b', directory: 'night-ra-image', connectorPath: 'src/gcl/image.ts', connectorBlob: '57ad4a906b2012c9802fd454787490b5db637b22', registryBlob: 'adebd1bde90230779827b9ee05d1d5f5507eda83', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: true },
  { batch: 'D21', name: 'RA 3D/game', revision: 'd739681', parentRevision: 'e2aca2f', directory: 'night-ra-3d-game', connectorPath: 'src/gcl/three-d.ts', connectorBlob: 'eccfc749f420702b6c7f206f72d54241a71ce05d', registryBlob: '0dcac2afddd3e6f133481f8b3735aa7ef8d2ffbc', hardDeniesLiveOptIn: false, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/result-boundary.ts', blob: 'cf6127caa4fb7549a73f92acdff69e6d7d7cf172' }], pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: '1530216aa8873f4b3df9ffe5ebc97086b6cc605c' }] },
  { batch: 'D21', name: 'RA market', revision: '112b3d8', parentRevision: '9b993a6', directory: 'night-ra-market', connectorPath: 'src/gcl/market.ts', connectorBlob: '6f25a2e074fbfe963e478da767bde91c001ed6aa', registryBlob: '43c6e166fb53af3607b811414a420ab1a4230cb2', hardDeniesLiveOptIn: true, quotaFailureAudited: false, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: 'af015f263316247e31302ae615ae02cef03d06f0' }] },
  { batch: 'D21', name: 'RFID', revision: 'f77a7f6', parentRevision: '5727465', directory: 'night-gm-rfid', connectorPath: 'src/gcl/rfid.ts', connectorBlob: '2420ab9384d05f09425e61ef7de1e407c8609819', registryBlob: '942c93c8f73266f4b2581723ab90666c423ae6da', hardDeniesLiveOptIn: false, quotaFailureAudited: true, strictOwnerApproval: false },
  { batch: 'D21', name: 'Translation', revision: '702b63f', parentRevision: '2443f1d', directory: 'night-gm-translate', connectorPath: 'src/gcl/translation.ts', connectorBlob: 'c0bf86902ed32af1b65352ad4fc6f891916db859', registryBlob: '28201ca26a3885b16b7658145d85be09e2dae60b', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: false, pinnedSupplementalBlobs: [{ path: 'src/gcl/audit.ts', blob: 'cf58248599246a754c9af6049b45b1534a363447' }, { path: 'src/gcl/context.ts', blob: '5a8e210cffd41158685d8598ca96f138f0b036ac' }, { path: 'src/gcl/errors.ts', blob: '3ab9868a21d80e7eecb2607a0aef7e9c9d554dd1' }, { path: 'src/gcl/translation-artifacts.ts', blob: '94f335e26920b64e979b069df71f98e49b3314ea' }] },
  { batch: 'D21', name: 'Language education', revision: '13b8963', parentRevision: 'a48bd08', directory: 'night-gm-langedu', connectorPath: 'src/gcl/language-education.ts', connectorBlob: 'ced2bb38ddc6e02f11d104eb93a1d69d5088ce49', registryBlob: '1de9365da8153242785b3fed37238f2e860d1842', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/types.ts', blob: '3a5b036186c03ac36d6b74ebaf8b2237ed9fc9db' }] },
  { batch: 'D21', name: 'Camera', revision: 'd896224', parentRevision: '79f758c', directory: 'night-gm-camera', connectorPath: 'src/gcl/camera.ts', connectorBlob: '026b562153205103028e0eb36ca12350869f9995', registryBlob: 'd2987b1c4dc1bd17114834f7c4bcb49c6474ccc9', hardDeniesLiveOptIn: true, quotaFailureAudited: true, strictOwnerApproval: true, pinnedClosureBlobs: [{ path: 'src/gcl/audit.ts', blob: '988edeffb4f2895df9ffe4c114f36e99892003a3' }, { path: 'src/gcl/errors.ts', blob: 'd91f8939d3d63d76aa016b1957e717a740fce5f4' }, { path: 'src/gcl/types.ts', blob: 'ece0b7cecbc4815b812f0d91aaca4d4debe605b5' }] },
]

function repositoryFor(snapshot: Snapshot): string {
  if (!/^[a-z0-9-]+$/.test(snapshot.directory)) throw new Error(`GCL_AUDIT_INVALID_WORKTREE:${snapshot.batch}:${snapshot.name}`)
  if (!/^[a-f0-9]{7,40}$/.test(snapshot.revision)) throw new Error(`GCL_AUDIT_INVALID_REVISION:${snapshot.batch}:${snapshot.name}`)
  return path.join(AUDIT_WORKTREE_ROOT, snapshot.directory)
}

function gitAt(snapshot: Snapshot, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryFor(snapshot), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(`GCL_AUDIT_SNAPSHOT_UNAVAILABLE:${snapshot.batch}:${snapshot.name}:${args.join(' ')}`)
  }
}

function sourceAt(snapshot: Snapshot, relativePath: string): string {
  if (!relativePath.startsWith(GCL_ROOT) || !relativePath.endsWith('.ts')) throw new Error(`GCL_AUDIT_INVALID_SOURCE_PATH:${snapshot.batch}:${snapshot.name}:${relativePath}`)
  return gitAt(snapshot, ['show', `${snapshot.revision}:${relativePath}`])
}

function gitBlobId(source: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source, 'utf8')}\0`).update(source).digest('hex')
}

function parsedTypeScriptSource(source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile('gcl-audit.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
  if (parseDiagnostics && parseDiagnostics.length > 0) throw new Error('GCL_AUDIT_INVALID_TYPESCRIPT_SOURCE')
  return sourceFile
}

function staticModuleSpecifiers(source: string): readonly string[] {
  const imports = new Set<string>()
  for (const statement of parsedTypeScriptSource(source).statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const moduleSpecifier = statement.moduleSpecifier
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) imports.add(moduleSpecifier.text)
  }
  return [...imports]
}

function localGclImportPaths(relativePath: string, source: string): readonly string[] {
  const imports = new Set<string>()
  for (const importedPath of staticModuleSpecifiers(source)) {
    if (!importedPath.startsWith('.')) continue
    const resolved = path.normalize(path.join(path.dirname(relativePath), importedPath)).replace(/\.js$/, '.ts')
    if (!resolved.startsWith(GCL_ROOT) || !resolved.endsWith('.ts')) throw new Error(`GCL_AUDIT_GCL_BOUNDARY_ESCAPE:${relativePath}:${importedPath}`)
    imports.add(resolved)
  }
  return [...imports]
}

function sourceClosure(snapshot: Snapshot): ReadonlyMap<string, string> {
  const pending = [snapshot.connectorPath, 'src/gcl/registry.ts', ...(snapshot.pinnedSupplementalBlobs ?? []).map(({ path: relativePath }) => relativePath)]
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

function sourceCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
}

/**
 * The only approved host-environment reference is a typed `environment`
 * default parameter. Connectors then expose only bounded GCL configuration
 * fields from that injected value; they must not pass, return, or alias the
 * host environment as a general runtime capability.
 */
function isAllowedProcessEnvironmentDefault(code: string, processIndex: number): boolean {
  const statementStart = Math.max(code.lastIndexOf('{', processIndex), code.lastIndexOf('}', processIndex), code.lastIndexOf(';', processIndex))
  const parameterPrefix = code.slice(statementStart + 1, processIndex)
  return /\b(?:function|constructor)\b[^{}]*\([^{}()]*\benvironment\s*:\s*NodeJS\.ProcessEnv\s*=\s*$/.test(parameterPrefix)
}

function assertNoProcessEnvironmentEscape(code: string, name: string): void {
  for (const match of code.matchAll(/\bprocess\s*(?:\.|\?\.)\s*env\b/g)) {
    const processIndex = match.index
    if (processIndex === undefined) throw new Error(`${name} process environment access must be locatable`)
    assert.equal(isAllowedProcessEnvironmentDefault(code, processIndex), true, `${name} must accept process.env only as a typed environment default parameter`)
  }
}

/**
 * A typed `environment = process.env` parameter is the sole permitted
 * process-root use.  Source-text checks can miss that root when it is wrapped
 * in a sequence, array, conditional, or object shorthand, so reject every
 * other AST value reference before it can become a retained capability.
 */
function isAllowedTypedProcessEnvironmentDefault(node: ts.Identifier, sourceFile: ts.SourceFile): boolean {
  const access = node.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== node || access.name.text !== 'env' || access.questionDotToken) return false

  let current: ts.Node = access
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) current = current.parent
  const parameter = current.parent
  return ts.isParameter(parameter)
    && parameter.initializer === current
    && ts.isIdentifier(parameter.name)
    && parameter.name.text === 'environment'
    && parameter.type?.getText(sourceFile).replace(/\s/g, '') === 'NodeJS.ProcessEnv'
}

function isDataPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isGetAccessorDeclaration(parent) && parent.name === node)
    || (ts.isSetAccessorDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)
}

function assertNoRetainedRuntimeRoot(source: string, name: string): void {
  const sourceFile = parsedTypeScriptSource(source)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === 'process' || node.text === 'module')) {
      if (isDataPropertyName(node)) {
        // A property name such as `packet.module` is ordinary input data, not a host root.
      } else if (node.text === 'process' && isAllowedTypedProcessEnvironmentDefault(node, sourceFile)) {
        // The bounded configuration seam is verified above and cannot be retained.
      } else {
        assert.fail(`${name} must not retain a ${node.text} runtime root outside the typed environment default`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * `Function` is a global code-evaluation capability in value position, but a
 * TypeScript `Function` type reference is erased before runtime. Preserve the
 * fail-closed rule for every value reference while avoiding a false runtime
 * capability finding for a parsed type annotation.
 */
function typeOnlyFunctionReferencePositions(sourceFile: ts.SourceFile): ReadonlySet<number> {
  const positions = new Set<number>()
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Function') {
      positions.add(node.typeName.getStart(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return positions
}

/**
 * A descriptor-safe data walker may stop before the built-in function
 * prototype. This exact strict comparison is structural only: it neither
 * obtains the Function constructor nor invokes a function. Every other
 * value-position reference remains a prohibited evaluation capability.
 */
function safeFunctionPrototypeComparisonPositions(sourceFile: ts.SourceFile): ReadonlySet<number> {
  const positions = new Set<number>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && !node.questionDotToken
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Function'
      && node.name.text === 'prototype'
      && ts.isBinaryExpression(node.parent)
      && node.parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && (node.parent.left === node ? ts.isIdentifier(node.parent.right) : node.parent.right === node && ts.isIdentifier(node.parent.left))
    ) positions.add(node.expression.getStart(sourceFile))
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return positions
}

function assertNoFunctionCapability(source: string, name: string): void {
  const sourceFile = parsedTypeScriptSource(source)
  const typeOnlyPositions = typeOnlyFunctionReferencePositions(sourceFile)
  const safePrototypeComparisonPositions = safeFunctionPrototypeComparisonPositions(sourceFile)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'Function') {
      const position = node.getStart(sourceFile)
      if (!typeOnlyPositions.has(position) && !safePrototypeComparisonPositions.has(position)) assert.fail(`${name} must not retain a Function runtime capability`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * Reflection on ordinary fixture data remains available, but a root or a
 * host-capability recovery method must not be retained for a later call. This
 * AST check covers array/object/sequence wrappers that a source-text alias
 * pattern alone cannot reliably distinguish from an immediate data operation.
 */
function isImmediatelyCalledExpression(expression: ts.Expression): boolean {
  let current: ts.Expression = expression
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
  ) current = current.parent
  return ts.isCallExpression(current.parent) && current.parent.expression === current
}

function assertNoRetainedReflectionCapability(source: string, name: string): void {
  const sourceFile = parsedTypeScriptSource(source)
  const retainedObjectMethods = new Set(['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getPrototypeOf'])
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'Reflect') {
      const parent = node.parent
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || !isImmediatelyCalledExpression(parent)) {
        assert.fail(`${name} must not retain a Reflect capability or method for later recovery`)
      }
    }
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Object'
      && retainedObjectMethods.has(node.name.text)
      && !isImmediatelyCalledExpression(node)
    ) assert.fail(`${name} must not retain an Object host-capability recovery method for later use`)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function assertNoRuntimeEscape(source: string, name: string): void {
  const code = sourceCode(source)
  assertNoProcessEnvironmentEscape(code, name)
  assertNoRetainedRuntimeRoot(source, name)
  assertNoFunctionCapability(source, name)
  assertNoRetainedReflectionCapability(source, name)
  assert.doesNotMatch(code, /\b(?:require|createRequire|eval)\b|\bimport\s*(?:\?\.)?\s*\(|\bimport\s*\.\s*meta\b|\bmodule\s*(?:\.|\?\.)\s*(?:require|constructor\s*(?:\.|\?\.)\s*_load)\b|\b(?:process|module)\s*(?:\.|\?\.)\s*(?:getBuiltinModule|binding|dlopen|mainModule|constructor)\b/, `${name} must not dynamically load or evaluate a runtime module`)
  assert.doesNotMatch(code, /\b(?:globalThis|global|window|Bun|Deno)\b|\bself\s*(?:\?\.|\.)|\bself\s*\[/, `${name} must not access a global runtime capability`)
  assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|navigator|sendBeacon|axios|undici|node-fetch)\b/, `${name} must not retain an egress capability by direct or aliased access`)
  assert.doesNotMatch(code, /\bReflect\s*(?:\?\.)?\s*(?:\.\s*get|\[\s*['"`]get['"`]\s*\])\s*\(\s*(?:globalThis|global|window|process(?:\s*(?:\.|\?\.)\s*env)?|module)\b/, `${name} must not reflectively obtain a runtime, module, or environment capability`)
  assert.doesNotMatch(code, /\bObject\s*(?:\?\.)?\s*(?:\.\s*getOwnPropertyDescriptors?|\[\s*['"`]getOwnPropertyDescriptors?['"`]\s*\])\s*\(\s*(?:globalThis|global|window|process(?:\s*(?:\.|\?\.)\s*env)?|module)\b/, `${name} must not obtain a runtime, module, or environment capability by descriptor`)
  assert.doesNotMatch(code, /\b(?:Object|Reflect)\s*(?:\?\.)?\s*(?:\.\s*getPrototypeOf|\[\s*['"`]getPrototypeOf['"`]\s*\])\s*\(\s*(?:globalThis|global|window|process|module)\b/, `${name} must not recover a host capability prototype`)
  assert.doesNotMatch(code, /\b(?:Reflect|Object)\s*(?:\?\.)?\s*(?:\.\s*(?:get|getOwnPropertyDescriptors?|getPrototypeOf)|\[\s*['"`](?:get|getOwnPropertyDescriptors?|getPrototypeOf)['"`]\s*\])\s*(?:\?\.)?\s*(?:\.\s*(?:call|apply|bind)|\[\s*['"`](?:call|apply|bind)['"`]\s*\])/, `${name} must not borrow reflective host-capability recovery`)
  assert.doesNotMatch(code, /\bReflect\s*(?:\?\.)?\s*(?:\.\s*apply|\[\s*['"`]apply['"`]\s*\])\s*\(\s*Reflect\s*(?:\?\.)?\s*(?:\.\s*get|\[\s*['"`]get['"`]\s*\])\b/, `${name} must not apply reflective host-capability recovery`)
  assert.doesNotMatch(code, /\b(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*\(?\s*(?:Reflect|Object)\s*\)?\s*(?:;|$)/m, `${name} must not alias a reflective root for later host-capability recovery`)
  assert.doesNotMatch(code, /\b(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*(?:Reflect\s*(?:\?\.)?\s*(?:\.\s*get\b|\[\s*['"`]get['"`]\s*\])|Object\s*(?:\?\.)?\s*(?:\.\s*(?:getOwnPropertyDescriptors?\b|getPrototypeOf\b)|\[\s*['"`](?:getOwnPropertyDescriptors?|getPrototypeOf)['"`]\s*\]))(?!\s*\()/, `${name} must not alias a reflective method for later host-capability recovery`)
  assert.doesNotMatch(code, /\b(?:process|environment)\s*(?:\?\.)?\s*\[/, `${name} must not use computed environment access`)
  assert.doesNotMatch(code, /\bmodule\s*(?:\?\.)?\s*\[/, `${name} must not use computed module capability recovery`)
  assert.doesNotMatch(code, /\bprocess\s*(?:\.|\?\.)\s*env\s*(?:\?\.)?\s*\[/, `${name} must not use computed environment access`)
  assert.doesNotMatch(code, /(?:process\s*(?:\.|\?\.)\s*env|environment)\s*(?:\?\.)?\s*\[\s*['"`][^'"`]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BEARER)[^'"`]*['"`]\s*\]/i, `${name} must not read a credential-like environment variable by bracket access`)
  assert.doesNotMatch(code, /(?:process\s*(?:\.|\?\.)\s*env|environment)\s*(?:\.|\?\.)\s*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*/i, `${name} must not read a credential-like environment variable`)
  assert.doesNotMatch(code, /\b(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*\(?\s*process\s*(?:\.|\?\.)\s*env\b|\b(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*\(?\s*process\b(?!\s*(?:\.|\?\.))/, `${name} must not alias a Node runtime or its environment for later capability recovery`)
  assert.doesNotMatch(code, /(?:\b[A-Za-z_$][A-Za-z0-9_$]*|\{[^}\n]*\}|\[[^\]\n]*\])\s*=\s*\(?\s*process\b(?!\s*(?:\.|\?\.))/, `${name} must not assign a Node runtime for later capability recovery`)
}

function moduleDeclarationsOf(source: string, importedPath: string): readonly (ts.ImportDeclaration | ts.ExportDeclaration)[] {
  return parsedTypeScriptSource(source).statements.filter((statement): statement is ts.ImportDeclaration | ts.ExportDeclaration => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return false
    return Boolean(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === importedPath)
  })
}

function isTypeOnlyModuleDeclaration(declaration: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(declaration)) return declaration.isTypeOnly
  const importClause = declaration.importClause
  if (!importClause) return false
  if (importClause.isTypeOnly) return true
  const namedBindings = importClause.namedBindings
  return Boolean(namedBindings && ts.isNamedImports(namedBindings) && namedBindings.elements.length > 0 && namedBindings.elements.every((element) => element.isTypeOnly))
}

function isAllowedTypeOnlyImport(source: string, importedPath: string): boolean {
  if (!ALLOWED_TYPE_ONLY_GCL_IMPORTS.has(importedPath)) return false
  const declarations = moduleDeclarationsOf(source, importedPath)
  return declarations.length > 0 && declarations.every(isTypeOnlyModuleDeclaration)
}

function assertAllowedImports(source: string, name: string): void {
  for (const importedPath of staticModuleSpecifiers(source)) {
    if (!importedPath.startsWith('.')) {
      const allowed = ALLOWED_NONLOCAL_GCL_IMPORTS.has(importedPath) || isAllowedTypeOnlyImport(source, importedPath)
      assert.equal(allowed, true, `${name} imports prohibited runtime module ${importedPath}`)
    }
  }
}

function quotaReservationIndex(registry: string): number {
  return Math.max(registry.indexOf('await this.quota.consume'), registry.indexOf('await quotaConsume.call'), registry.indexOf('await this.quotaConsume'))
}

function auditCapturesQuotaFailure(registry: string): boolean {
  const requestedAudit = registry.indexOf('const requestedAudit')
  const protectedExecution = registry.indexOf('try {', requestedAudit)
  const quota = quotaReservationIndex(registry)
  const failureAudit = Math.max(
    registry.indexOf("type: 'connector.run.failed'", quota),
    registry.indexOf("this.event('connector.run.failed'", quota),
  )
  const failureSource = registry.slice(failureAudit)
  const directRequestedLink = failureSource.includes('requestedAuditHash: requestedAudit.hash')
  const requestedHashBoundAtReservation = /const requestedAuditHash\s*=\s*returnedAuditHash\(await auditAppend\.call\(/.test(registry.slice(requestedAudit, protectedExecution))
  const directRequestedHashLink = requestedHashBoundAtReservation && /\brequestedAuditHash\s*(?=[,}])/.test(failureSource)
  const helperCall = failureSource.match(/\bdetail\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\(\s*requestedAudit\.hash\b/)
  const helperName = helperCall?.[1]
  const helperStart = helperName ? registry.indexOf(`function ${helperName}(`) : -1
  const helperEnd = helperStart >= 0 ? registry.indexOf('\n}', helperStart) : -1
  const helperSource = helperEnd >= 0 ? registry.slice(helperStart, helperEnd) : ''
  const helperForwardsRequestedLink = Boolean(helperName)
    && /^function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*requestedAuditHash\b/.test(helperSource)
    && /\brequestedAuditHash\s*(?::|[,}])/.test(helperSource)
  return requestedAudit >= 0 && protectedExecution > requestedAudit && protectedExecution < quota && failureAudit > quota && (directRequestedLink || directRequestedHashLink || helperForwardsRequestedLink)
}

function hardDeniesLiveOptIn(connector: string): boolean {
  const directRejection = /if \((?:this\.)?config\.liveEnabled(?:\)| !== false\)) throw new ConnectorUnavailableError/.test(connector)
  const environmentPoisonPill = /Object\.hasOwn\(environment, 'GCL_[A-Z0-9_]+_LIVE_ENABLED'\)/.test(connector)
    && /syntheticEnabled:\s*environment\.GCL_[A-Z0-9_]+_SYNTHETIC_ENABLED\s*===\s*'true'\s*&&\s*!liveOptInWasProvided/.test(connector)
  const descriptorBoundPoisonPill = /const liveOptIn = ownEnvironmentSetting\(environment, 'GCL_[A-Z0-9_]+_LIVE_ENABLED'\)/.test(connector)
    && /syntheticEnabled:\s*syntheticEnabled\.value\s*===\s*'true'\s*&&\s*!liveOptIn\.provided/.test(connector)
  return directRejection || environmentPoisonPill || descriptorBoundPoisonPill
}

function ownerDenialPrecedesReservations(registry: string): boolean {
  const ownerGate = registry.search(/if \((?:!(?:request|context|safeRequest|validated)\.ownerApproved|(?:request|context|safeRequest|validated)\.ownerApproved !== true)\) throw new OwnerGateError/)
  const preflight = registry.indexOf('await connector.preflight')
  const requestedAudit = registry.indexOf('const requestedAudit')
  const quota = quotaReservationIndex(registry)
  return ownerGate >= 0 && ownerGate < preflight && preflight < requestedAudit && requestedAudit < quota
}

/**
 * A deny-by-default owner gate needs either an explicit `=== true` check, or
 * a runtime boolean validation that precedes a conventional falsy check. A
 * TypeScript annotation alone is erased and cannot protect a JavaScript
 * caller that supplies a truthy string or object.
 */
function strictOwnerApprovalGate(registry: string): boolean {
  const explicitGate = /if \(\s*(?:request|context|safeRequest|validated|normalizedRequest)\.ownerApproved\s*!==\s*true\s*\) throw new OwnerGateError/.test(registry)
  if (explicitGate) return true
  const runtimeBooleanValidation = /typeof\s+(?:request|ownerApproved)\s*(?:\.|\?\.)?ownerApproved\s*!==\s*['"]boolean['"]|typeof\s+ownerApproved\s*!==\s*['"]boolean['"]/.test(registry)
  const falsyGate = /if \(\s*!\s*(?:request|context|safeRequest|validated|normalizedRequest)\.ownerApproved\s*\) throw new OwnerGateError/.test(registry)
  return runtimeBooleanValidation && falsyGate
}

/** A revoked Proxy can throw during Array.isArray, so detection must come first. */
function proxyArrayIngressRejectedBeforeInspection(source: string): boolean {
  return /isProxyObject\(value\.syntheticFields\)\s*\|\|\s*!Array\.isArray\(value\.syntheticFields\)/.test(source)
}

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14/D15/D16/D17/D18/D19/D20/D21 source fixture pins every audited connector and its governance runner to local Git objects', () => {
  for (const snapshot of snapshots) {
    const resolvedRevision = gitAt(snapshot, ['rev-parse', '--verify', `${snapshot.revision}^{commit}`]).trim()
    assert.equal(resolvedRevision.startsWith(snapshot.revision), true, `${snapshot.name} revision does not resolve to its pinned commit`)
    if (snapshot.parentRevision) {
      const parentRevision = gitAt(snapshot, ['rev-parse', '--verify', `${snapshot.revision}^`]).trim()
      assert.equal(parentRevision.startsWith(snapshot.parentRevision), true, `${snapshot.name} is not the exact direct child of ${snapshot.parentRevision}`)
    }
    assert.equal(gitBlobId(sourceAt(snapshot, snapshot.connectorPath)), snapshot.connectorBlob, `${snapshot.name} connector source changed from ${snapshot.revision}`)
    assert.equal(gitBlobId(sourceAt(snapshot, 'src/gcl/registry.ts')), snapshot.registryBlob, `${snapshot.name} runner source changed from ${snapshot.revision}`)
    for (const closureBlob of snapshot.pinnedClosureBlobs ?? []) {
      assert.equal(gitBlobId(sourceAt(snapshot, closureBlob.path)), closureBlob.blob, `${snapshot.name} closure source changed from ${snapshot.revision}`)
      assert.equal(sourceClosure(snapshot).has(closureBlob.path), true, `${snapshot.name} pinned source is outside the audited local GCL closure`)
    }
    for (const supplementalBlob of snapshot.pinnedSupplementalBlobs ?? []) {
      assert.equal(gitBlobId(sourceAt(snapshot, supplementalBlob.path)), supplementalBlob.blob, `${snapshot.name} supplemental source changed from ${snapshot.revision}`)
      assert.equal(sourceClosure(snapshot).has(supplementalBlob.path), true, `${snapshot.name} supplemental source is outside the audited local GCL package closure`)
    }
  }
})

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14/D15/D16/D17/D18/D19/D20/D21 synthetic source closure has no egress, privileged configuration, subprocess, or send surface', () => {
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
    assertNoRuntimeEscape(closure, `${snapshot.batch} ${snapshot.name}`)
    assertAllowedImports(closure, `${snapshot.batch} ${snapshot.name}`)
    const hasLiveEnableEnvironment = /GCL_[A-Z0-9_]+_LIVE_ENABLED/.test(connector)
    assert.equal(hasLiveEnableEnvironment, snapshot.hardDeniesLiveOptIn, `${snapshot.name} live-enable surface changed`)
    if (snapshot.hardDeniesLiveOptIn) assert.equal(hardDeniesLiveOptIn(connector), true, `${snapshot.name} must reject a true live flag`)
  }
})

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14/D15/D16/D17/D18/D19/D20/D21 denied-owner and quota-rejection edge cases are classified without overstating conformance', () => {
  for (const snapshot of snapshots) {
    const registry = sourceAt(snapshot, 'src/gcl/registry.ts')
    assert.equal(ownerDenialPrecedesReservations(registry), true, `${snapshot.name} denied owner could reach preflight, audit reservation, or quota`)
    assert.equal(auditCapturesQuotaFailure(registry), snapshot.quotaFailureAudited, `${snapshot.name} quota-failure audit classification changed`)
  }
})

test('D5 fail-closed safety checks reject optional reflective descriptors and computed environment capability recovery', () => {
  for (const source of [
    "const adapter = import('node:https')",
    "const request = globalThis['fetch']",
    "const request = globalThis?.fetch",
    "const request = globalThis?.['fetch']",
    "const request = Reflect.get(globalThis, 'fetch')",
    "const request = Reflect['get'](globalThis, 'fetch')",
    "const request = Reflect?.get(globalThis, 'fetch')",
    "const request = Reflect?.['get'](globalThis, 'fetch')",
    "const request = globalThis['fe' + 'tch']",
    "const request = (globalThis).fetch",
    "const request = Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.value",
    "const request = Object?.['getOwnPropertyDescriptor'](globalThis, 'fetch')?.value",
    "const request = Object.getOwnPropertyDescriptors(globalThis).fetch.value",
    "const response = fetch?.('https://synthetic.invalid')",
    "const token = process.env['SYNTHETIC_API_KEY']",
    "const token = process.env?.['SYNTHETIC_TOKEN']",
    "const token = process.env?.['SYNTHETIC_' + 'TOKEN']",
    "const token = process['env']?.['SYNTHETIC_TOKEN']",
    "const environment = process['en' + 'v']",
    "const token = process?.env?.SYNTHETIC_TOKEN",
    "const token = Reflect.get(process.env, 'SYNTHETIC_TOKEN')",
    "const token = Object.getOwnPropertyDescriptor(process.env, 'SYNTHETIC_TOKEN')?.value",
    "const token = Object?.['getOwnPropertyDescriptors'](process.env).SYNTHETIC_TOKEN.value",
    "const childProcess = require('node:child_process')",
    "const childProcess = module?.require('node:child_process')",
    "const adapter = import /* deferred */ ('node:https')",
    "const runtime = Function('return process')()",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D5 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const enabled = environment.GCL_RFID_SYNTHETIC_ENABLED === 'true'", 'D5 allowed synthetic configuration'))
  assert.throws(() => assertAllowedImports("import { request } from 'node:https'", 'D5 negative probe'))
  assert.throws(() => assertAllowedImports("import { PrismaClient } from '@prisma/client'", 'D5 negative probe'))
  assert.doesNotThrow(() => assertAllowedImports("import { type PrismaClient } from '@prisma/client'", 'D5 allowed erased type import'))
  assert.throws(() => localGclImportPaths('src/gcl/connector.ts', "import '../auth.js'"))
})

test('D6 fail-closed safety checks reject builtin module recovery and non-fetch browser egress capabilities', () => {
  for (const source of [
    "const transport = process.getBuiltinModule('node:https')",
    "const transport = module.constructor._load('node:https')",
    "const transport = require?.call(undefined, 'node:https')",
    "const sent = navigator.sendBeacon('https://synthetic.invalid', 'fixture')",
    "const stream = new EventSource('https://synthetic.invalid')",
    "const stream = new WebTransport('https://synthetic.invalid')",
    'const request = self.fetch',
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D6 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const enabled = environment.GCL_TRANSLATION_SYNTHETIC_ENABLED === 'true'", 'D6 allowed synthetic configuration'))
})

test('D7 fail-closed safety checks reject native-loader, import-meta, and alternate runtime capability recovery', () => {
  for (const source of [
    "const binding = process.binding('http_wrap')",
    "const binding = process?.binding('http_wrap')",
    "const loader = process.mainModule",
    "const native = process.dlopen",
    "const resolved = import.meta.resolve('node:https')",
    "const connection = Bun.connect({ hostname: 'synthetic.invalid', port: 443 })",
    "const connection = Deno.connect({ hostname: 'synthetic.invalid', port: 443 })",
    "const listener = Deno.serve(() => new Response('fixture'))",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D7 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const enabled = environment.GCL_CAMERA_SYNTHETIC_ENABLED === 'true'", 'D7 allowed synthetic configuration'))
})

test('D8 fail-closed safety checks reject Node runtime/environment aliases and constructor recovery', () => {
  for (const source of [
    'const environment = process.env',
    'const environment = process?.env',
    'const environment = (process.env)',
    'const { env } = process',
    'const runtime = process',
    "const factory = process.constructor.constructor('return 1')()",
    "const factory = module?.constructor?.constructor('return 1')()",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D8 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const enabled = environment.GCL_LANGEDU_SYNTHETIC_ENABLED === 'true'", 'D8 allowed synthetic configuration'))
})

test('D9 fail-closed safety checks restrict host environment access to typed configuration defaults', () => {
  for (const source of [
    'let runtime: unknown; runtime = process',
    'function unsafe(runtime = process) { return runtime.env }',
    'const unsafe = ({ env } = process) => env',
    'function unsafe(source: NodeJS.ProcessEnv = process.env) { return source.GCL_RFID_LIVE_MODE }',
    'const unsafe = (environment = process.env) => environment.GCL_RFID_LIVE_MODE',
    'setSyntheticEnvironment(process.env)',
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D9 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("function safe(environment: NodeJS.ProcessEnv = process.env) { return environment.GCL_RFID_LIVE_MODE === 'LIVE_DISABLED' }", 'D9 allowed typed synthetic configuration default'))
})

test('D10 fail-closed safety checks reject computed CommonJS loader recovery', () => {
  for (const source of [
    "const loader = module['constructor']['_load']('node:https')",
    "const loader = module?.['constructor']?.['_load']('node:https')",
    'const factory = Function',
    "const factory = new Function('return process')",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D10 negative probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape('function typeOnly(callback: Function): void { callback }', 'D10 allowed erased Function type'))
})

test('D11 fail-closed static module parsing covers multiline imports and exports', () => {
  const multilineNodeImport = "import {\n  request\n} from 'node:https'"
  const multilineNodeExport = "export {\n  request\n} from 'node:https'"
  const multilineBoundaryEscape = "import {\n  credential\n} from '../auth.js'"
  const multilineTypeOnlyImport = "import {\n  type PrismaClient\n} from '@prisma/client'"

  assert.throws(() => assertAllowedImports(multilineNodeImport, 'D11 multiline import probe'))
  assert.throws(() => assertAllowedImports(multilineNodeExport, 'D11 multiline export probe'))
  assert.throws(() => localGclImportPaths('src/gcl/connector.ts', multilineBoundaryEscape))
  assert.doesNotThrow(() => assertAllowedImports(multilineTypeOnlyImport, 'D11 allowed erased multiline type import'))
  assert.throws(() => staticModuleSpecifiers("import {\n  request from 'node:https'"))
})

test('D11 permits only a strict descriptor-walker comparison to Function.prototype', () => {
  assert.doesNotThrow(() => assertNoRuntimeEscape('const terminal = target !== Function.prototype', 'D11 descriptor-walker terminal comparison'))
  for (const source of [
    'const prototype = Function.prototype',
    'const factory = Function.prototype.constructor',
    'const terminal = target !== Function?.prototype',
    'const terminal = target === Function.prototype',
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D11 Function capability probe: ${source}`))
})

test('D12 fail-closed safety checks reject reflective recovery from the Node and CommonJS roots', () => {
  for (const source of [
    "const environment = Reflect.get(process, 'env')",
    "const environment = Reflect?.['get'](process, 'env')",
    "const environment = Object.getOwnPropertyDescriptor(process, 'env')?.value",
    "const environment = Object?.['getOwnPropertyDescriptors'](process).env.value",
    "const loader = Reflect.get(module, 'require')",
    "const loader = Object.getOwnPropertyDescriptor(module, 'require')?.value",
    'const prototype = Object.getPrototypeOf(process)',
    "const prototype = Reflect['getPrototypeOf'](module)",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D12 host-root recovery probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const keys = Reflect.ownKeys(input)", 'D12 allowed own-data reflection'))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const descriptor = Object.getOwnPropertyDescriptor(input, 'value')", 'D12 allowed own-data descriptor'))
})

test('D13 fail-closed safety checks reject borrowed reflective host-capability recovery', () => {
  for (const source of [
    "const environment = Reflect.get.call(Reflect, process, 'env')",
    "const environment = Reflect.apply(Reflect.get, Reflect, [process, 'env'])",
    "const environment = Object.getOwnPropertyDescriptor.call(Object, process, 'env')?.value",
    "const environment = Object.getOwnPropertyDescriptors.apply(Object, [process]).env.value",
    "const prototype = Reflect.getPrototypeOf.call(Reflect, module)",
    "const loader = Reflect.apply(Reflect.get, Reflect, [module, 'require'])",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D13 borrowed reflection probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const keys = Reflect.ownKeys(input)", 'D13 allowed own-data reflection'))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const descriptor = Object.getOwnPropertyDescriptor(input, 'value')", 'D13 allowed own-data descriptor'))
})

test('D14 fail-closed safety checks reject aliases of reflective roots and host-capability methods', () => {
  for (const source of [
    'const reflection = Reflect',
    'const objectIntrinsic = Object',
    "const get = Reflect.get; const environment = get(process, 'env')",
    "let descriptor; descriptor = Object.getOwnPropertyDescriptor; const environment = descriptor(process, 'env')",
    "const { get: lookup } = Reflect; const loader = lookup(module, 'require')",
    "const prototypeOf = Object.getPrototypeOf; const processPrototype = prototypeOf(process)",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D14 reflection-alias probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const descriptor = Object.getOwnPropertyDescriptor(input, 'value')", 'D14 allowed own-data descriptor'))
  assert.doesNotThrow(() => assertNoRuntimeEscape('const keys = Reflect.ownKeys(input)', 'D14 allowed own-data reflection'))
})

test('D15 fail-closed safety checks reject wrapped or structured aliases of reflection recovery methods', () => {
  for (const source of [
    "const [lookup] = [Reflect.get]; const environment = lookup(process, 'env')",
    "const helpers = { lookup: Reflect.get }; const environment = helpers.lookup(process, 'env')",
    "const lookup = (0, Reflect.get); const environment = lookup(process, 'env')",
    "const lookup = Reflect['get']; const environment = lookup(process, 'env')",
    "const [descriptor] = [Object.getOwnPropertyDescriptor]; const environment = descriptor(process, 'env')",
    "const helpers = { descriptors: Object.getOwnPropertyDescriptors }; const environment = helpers.descriptors(process).env",
    "const prototypeOf = (0, Object.getPrototypeOf); const prototype = prototypeOf(module)",
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D15 reflection-wrapper probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const descriptor = Object.getOwnPropertyDescriptor(input, 'value')", 'D15 allowed immediate own-data descriptor'))
  assert.doesNotThrow(() => assertNoRuntimeEscape('const keys = Reflect.ownKeys(input)', 'D15 allowed immediate own-data reflection'))
})

test('D16 fail-closed safety checks reject wrapped process and module roots before capability recovery', () => {
  for (const source of [
    'const runtime = (0, process)',
    'const runtime = [process][0]',
    'const runtime = true ? process : module',
    'const holder = { process }; const runtime = holder.process',
    'const holder = { module }; const runtime = holder.module',
    'const { env } = (0, process)',
    'const loader = [module][0]',
  ]) assert.throws(() => assertNoRuntimeEscape(source, `D16 runtime-root wrapper probe: ${source}`))
  assert.doesNotThrow(() => assertNoRuntimeEscape('function safe(environment: NodeJS.ProcessEnv = process.env) { return environment.GCL_CAMERA_SYNTHETIC_ENABLED === \'true\' }', 'D16 allowed typed synthetic configuration default'))
  assert.doesNotThrow(() => assertNoRuntimeEscape("const packet = { module: 'synthetic' }; const label = packet.module", 'D16 allowed ordinary data property'))
})

test('D17 audit-receipt edge accepts only a bounded receipt and never continues a malformed append with a synthetic failure event', () => {
  const camera = snapshots.find((snapshot) => snapshot.batch === 'D17' && snapshot.name === 'Camera')
  assert.ok(camera, 'D17 camera snapshot must be present')

  const audit = sourceAt(camera, 'src/gcl/audit.ts')
  const registry = sourceAt(camera, 'src/gcl/registry.ts')
  const connector = sourceAt(camera, camera.connectorPath)

  assert.match(audit, /nodeTypes\.isProxy\(value\)/, 'D17 audit receipts must reject Proxy wrappers before descriptor inspection')
  assert.match(audit, /names\.length !== 1 \|\| names\[0\] !== 'hash'/, 'D17 audit receipts must reject extra or missing fields')
  assert.match(audit, /!descriptor \|\| !\('value' in descriptor\) \|\| !descriptor\.enumerable \|\| typeof descriptor\.value !== 'string' \|\| !SHA256_PATTERN\.test\(descriptor\.value\)/, 'D17 audit receipts must reject accessor, hidden, or malformed hash values')
  assert.match(audit, /return validateAuditAppendReceipt\(await auditLog\.append\(event\)\)/, 'D17 audit append must validate before exposing a hash')
  assert.doesNotMatch(registry, /this\.auditLog\.append\(/, 'D17 governed runner must not bind an unvalidated audit receipt')
  assert.doesNotMatch(connector, /\bauditLog\.append\(/, 'D17 camera review must not bind an unvalidated audit receipt')
  assert.match(registry, /if \(error instanceof AuditReceiptError\) throw error/, 'D17 malformed terminal receipt must stop without appending a second failure transition')
})

test('D18 direct-successor package preserves immutable lineage and classifies truthy owner-approval bypasses fail closed', () => {
  const d18 = snapshots.filter((snapshot) => snapshot.batch === 'D18')
  assert.equal(d18.length, 8, 'D18 must cover the eight direct successor packages')

  for (const snapshot of d18) {
    assert.notEqual(snapshot.parentRevision, undefined, `${snapshot.name} must name its audited parent`)
    const registry = sourceAt(snapshot, 'src/gcl/registry.ts')
    assert.equal(strictOwnerApprovalGate(registry), snapshot.strictOwnerApproval, `${snapshot.name} strict owner-approval classification changed`)
    if (snapshot.proxyArrayIngressSafe !== undefined) {
      const connector = sourceAt(snapshot, snapshot.connectorPath)
      assert.equal(proxyArrayIngressRejectedBeforeInspection(connector), snapshot.proxyArrayIngressSafe, `${snapshot.name} Proxy-array ingress classification changed`)
    }
  }

  assert.equal(strictOwnerApprovalGate('if (!request.ownerApproved) throw new OwnerGateError()'), false, 'an erased TypeScript type cannot reject a truthy owner value')
  assert.equal(strictOwnerApprovalGate("if (typeof request.ownerApproved !== 'boolean') throw new ConnectorInputError(); if (!validated.ownerApproved) throw new OwnerGateError()"), true, 'runtime boolean validation may precede a falsy owner gate')
})

test('D18 synthetic boundary additions remain proposal-only and reject the newly audited edge cases', () => {
  const snapshot = (name: string): Snapshot => {
    const found = snapshots.find((candidate) => candidate.batch === 'D18' && candidate.name === name)
    assert.ok(found, `D18 ${name} snapshot must be present`)
    return found
  }

  const ocr = sourceAt(snapshot('RA OCR'), 'src/gcl/vision.ts')
  assert.match(ocr, /if \(!value \|\| typeof value !== 'object'\) return false\s+if \(isProxyObject\(value\)\) return false\s+if \(Array\.isArray\(value\)\) return false/, 'D18 OCR must retain its top-level Proxy-before-Array record guard')
  assert.match(ocr, /value\.proxyObjectsAccepted !== false \|\| value\.proxyArraysAccepted !== false/, 'D18 OCR packet must bind both Proxy rejection claims')
  assert.equal(proxyArrayIngressRejectedBeforeInspection(ocr), false, 'D18 OCR must remain classified nonconformant until a Proxy array is rejected before Array.isArray')

  const threeD = sourceAt(snapshot('RA 3D/game'), 'src/gcl/result-boundary.ts')
  assert.match(threeD, /input\.outputFormat === 'glb' \|\| input\.outputFormat === 'obj'/, 'D18 3D result review must retain a bounded requested format')
  assert.match(threeD, /artifact\.outputFormat === input\.outputFormat/, 'D18 3D result review must reject an artifact-format substitution')

  const market = snapshot('RA market')
  const marketConnector = sourceAt(market, market.connectorPath)
  const marketRegistry = sourceAt(market, 'src/gcl/registry.ts')
  assert.match(marketConnector, /preflight\(input: SyntheticMarketInput, ctx: ConnectorRunContext\): SyntheticMarketInput \{\s+return validatedRequest\(this\.config, input, ctx\)/, 'D18 market preflight must return a canonical scalar-only request')
  assert.match(marketRegistry, /const preparedInput = await connector\.preflight\?\.\(safeRequest\.input, context\)\s+const connectorInput = preparedInput === undefined \? safeRequest\.input : preparedInput/, 'D18 market runner must select the preflight snapshot before audit or quota')
  assert.match(marketRegistry, /await connector\.run\(connectorInput, context\)/, 'D18 market runner must not pass the preflight caller object to run when a snapshot exists')

  const rfid = sourceAt(snapshot('RFID'), 'src/gcl/rfid.ts')
  assert.match(rfid, /execution: 'SYNTHETIC_EXCEPTION_WAIVER_BOUNDARY_REVIEW_PROPOSAL_ONLY_NOT_EXECUTED'/, 'D18 RFID waiver boundary must remain a non-executed proposal')
  assert.match(rfid, /exceptionOrWaiverInput: 'NOT_ACCEPTED'/, 'D18 RFID waiver boundary must accept no waiver input')
  assert.match(rfid, /ownerOrRoleBasedOverride: 'NOT_GRANTED'/, 'D18 RFID waiver boundary must not grant an owner or role override')

  const translationRegistry = sourceAt(snapshot('Translation'), 'src/gcl/registry.ts')
  assert.match(translationRegistry, /new Set\(value\)\.size !== value\.length/, 'D18 translation must reject duplicate scopes rather than silently deduplicating authority')

  const languageEducation = sourceAt(snapshot('Language education'), 'src/gcl/language-education.ts')
  assert.match(languageEducation, /const input = exact\(value, \['synthetic', 'reflectionRef', 'reflectionHash', 'locale', 'activity'\]\)/, 'D18 language reflection accepts only a bounded fixture reference')
  assert.match(languageEducation, /reflection: 'NO_LEARNER_RESPONSE_SENTIMENT_OR_WELLBEING_INFERENCE'/, 'D18 language reflection must deny response and wellbeing inference')
  assert.doesNotMatch(languageEducation, /reflectionText|learnerResponse|sentimentScore|wellbeingScore/, 'D18 language reflection must not add raw response or inference fields')
})

test('D19 next direct-successor package keeps immutable lineage, owner classifications, and the repaired OCR Proxy-array boundary', () => {
  const d19 = snapshots.filter((snapshot) => snapshot.batch === 'D19')
  assert.equal(d19.length, 8, 'D19 must cover the eight direct successor packages')

  for (const snapshot of d19) {
    assert.notEqual(snapshot.parentRevision, undefined, `${snapshot.name} must name its D18 parent`)
    const registry = sourceAt(snapshot, 'src/gcl/registry.ts')
    assert.equal(strictOwnerApprovalGate(registry), snapshot.strictOwnerApproval, `${snapshot.name} strict owner-approval classification changed`)
  }

  const ocr = d19.find((snapshot) => snapshot.name === 'RA OCR')
  assert.ok(ocr, 'D19 RA OCR snapshot must be present')
  const ocrConnector = sourceAt(ocr, ocr.connectorPath)
  assert.equal(proxyArrayIngressRejectedBeforeInspection(ocrConnector), true, 'D19 OCR must reject a Proxy syntheticFields array before Array.isArray can inspect it')
  assert.match(ocrConnector, /if \(isProxyObject\(value\.syntheticFields\) \|\| !Array\.isArray\(value\.syntheticFields\)\) throw new ConnectorInputError\('INVALID_SYNTHETIC_DOCUMENT_FIELDS'\)/, 'D19 OCR must turn revoked Proxy-array ingress into a closed connector input denial')
})

test('D19 new immutable boundaries reject shaped clocks, configuration, waiver, and audit-event ingress without enabling an action', () => {
  const snapshot = (name: string): Snapshot => {
    const found = snapshots.find((candidate) => candidate.batch === 'D19' && candidate.name === name)
    assert.ok(found, `D19 ${name} snapshot must be present`)
    return found
  }

  const image = sourceAt(snapshot('RA image'), 'src/gcl/image.ts')
  assert.match(image, /Object\.getPrototypeOf\(value\) !== Date\.prototype/, 'D19 image must reject a subclassed or shaped injected clock')
  assert.match(image, /Date\.prototype\.getTime\.call\(value\)/, 'D19 image must use the intrinsic Date getter after the exact-prototype check')
  assert.match(image, /Object\.getOwnPropertyNames\(candidate\)\.some\(\(key\) => key !== 'prompt'/, 'D19 image must see non-enumerable unexpected input keys')
  assert.doesNotMatch(image, /Object\.keys\(candidate\)\.some/, 'D19 image must not omit hidden unexpected input keys')

  const market = sourceAt(snapshot('RA market'), 'src/gcl/market.ts')
  assert.match(market, /function snapshotMarketConnectorConfig\(value: unknown\): SyntheticMarketConnectorConfig \| null/, 'D19 market must snapshot constructor configuration')
  assert.match(market, /nodeTypes\.isProxy\(value\)/, 'D19 market must deny a Proxy configuration before structural inspection')
  assert.match(market, /names\.some\(\(field\) => !MARKET_CONFIG_FIELDS\.includes\(field as typeof MARKET_CONFIG_FIELDS\[number\]\)\)/, 'D19 market must reject unknown, including credential-like, configuration fields')
  assert.match(market, /return Object\.freeze\(snapshot\) as SyntheticMarketConnectorConfig/, 'D19 market must not retain a mutable constructor configuration')

  const rfid = sourceAt(snapshot('RFID'), 'src/gcl/rfid.ts')
  assert.match(rfid, /execution: 'SYNTHETIC_EXCEPTION_WAIVER_BOUNDARY_REVIEW_PROPOSAL_ONLY_NOT_EXECUTED'/, 'D19 RFID waiver boundary must remain a non-executed proposal')
  assert.match(rfid, /exceptionOrWaiverInput: 'NOT_ACCEPTED'/, 'D19 RFID must reject an exception or waiver input')
  assert.match(rfid, /pilotOrLiveEnablement: 'FORBIDDEN'/, 'D19 RFID must not enable a pilot or live mode')
  assert.match(rfid, /controlEgressOrCredentialReenablement: 'FORBIDDEN'/, 'D19 RFID must not restore control egress or credentials')
  assert.match(rfid, /automaticAction: false/, 'D19 RFID must not turn the boundary review into an action')

  const camera = snapshot('Camera')
  const audit = sourceAt(camera, 'src/gcl/audit.ts')
  const registry = sourceAt(camera, 'src/gcl/registry.ts')
  assert.match(audit, /export function sealAuditAppendEvent\(value: unknown\): ConnectorAuditEvent/, 'D19 camera must seal the event before append')
  assert.match(audit, /nodeTypes\.isProxy\(value\)/, 'D19 camera must reject a Proxy audit event before descriptor inspection')
  assert.match(audit, /ancestors\.has\(value\)/, 'D19 camera must reject cyclic audit detail before append')
  assert.match(audit, /return validateAuditAppendReceipt\(await auditLog\.append\(sealAuditAppendEvent\(event\)\)\)/, 'D19 camera must append only the sealed audit event')
  assert.match(registry, /if \(error instanceof AuditReceiptError \|\| error instanceof AuditEventError\) throw error/, 'D19 camera must stop after a malformed audit event instead of adding a failure transition')
})

test('D20 direct-successor package keeps immutable lineage and does not reclassify inherited governance gaps', () => {
  const d20 = snapshots.filter((snapshot) => snapshot.batch === 'D20')
  assert.equal(d20.length, 8, 'D20 must cover the eight direct successor packages')

  for (const snapshot of d20) {
    const parent = snapshots.find((candidate) => candidate.batch === 'D19' && candidate.name === snapshot.name)
    assert.ok(parent, `D20 ${snapshot.name} must have a D19 package counterpart`)
    assert.equal(snapshot.parentRevision, parent.revision, `D20 ${snapshot.name} must name the exact D19 parent`)
    const registry = sourceAt(snapshot, 'src/gcl/registry.ts')
    assert.equal(strictOwnerApprovalGate(registry), snapshot.strictOwnerApproval, `${snapshot.name} strict owner-approval classification changed`)
  }

  for (const name of ['RA image', 'RFID']) {
    const d19 = snapshots.find((snapshot) => snapshot.batch === 'D19' && snapshot.name === name)
    const d20Snapshot = d20.find((snapshot) => snapshot.name === name)
    assert.ok(d19 && d20Snapshot, `D20 ${name} snapshots must be present`)
    assert.equal(sourceAt(d20Snapshot, d20Snapshot.connectorPath), sourceAt(d19, d19.connectorPath), `D20 ${name} must not overstate a documentation or unit-only change as new connector behaviour`)
    assert.equal(sourceAt(d20Snapshot, 'src/gcl/registry.ts'), sourceAt(d19, 'src/gcl/registry.ts'), `D20 ${name} must not overstate a documentation or unit-only change as new runner behaviour`)
  }
})

test('D20 new immutable boundaries reject deadline overflow, mutable configuration, expired review authority, and malformed durable audit heads', () => {
  const snapshot = (name: string): Snapshot => {
    const found = snapshots.find((candidate) => candidate.batch === 'D20' && candidate.name === name)
    assert.ok(found, `D20 ${name} snapshot must be present`)
    return found
  }

  const ocr = sourceAt(snapshot('RA OCR'), 'src/gcl/vision.ts')
  assert.match(ocr, /const MAX_UTC_EPOCH_MILLISECONDS = 8_640_000_000_000_000/, 'D20 OCR must name the bounded ECMAScript epoch ceiling')
  assert.match(ocr, /function checkedDateAddSeconds\(value: Date, seconds: number, error: string\): Date/, 'D20 OCR must use one checked synthetic deadline helper')
  assert.match(ocr, /Math\.abs\(resultMilliseconds\) > MAX_UTC_EPOCH_MILLISECONDS\) throw new ConnectorInputError\(error\)/, 'D20 OCR must reject date arithmetic overflow before serializing a deadline')
  assert.match(ocr, /checkedDateAddSeconds\(capturedAt, maxEvidenceAgeSeconds, 'DOCUMENT_EVIDENCE_EXPIRY_ARITHMETIC_INVALID'\)/, 'D20 OCR must protect evidence-expiry arithmetic')
  assert.match(ocr, /checkedDateAddSeconds\(issuedAt, maxReviewAgeSeconds, 'DOCUMENT_REVIEW_WINDOW_ARITHMETIC_INVALID'\)/, 'D20 OCR must protect review-window arithmetic')
  assert.match(ocr, /reviewedDateArithmeticBoundaryBinding/, 'D20 OCR must bind and revalidate the arithmetic safety claim in independent review')

  const threeD = snapshot('RA 3D/game')
  const threeDRegistry = sourceAt(threeD, 'src/gcl/registry.ts')
  const threeDAudit = sourceAt(threeD, 'src/gcl/audit.ts')
  assert.match(threeDRegistry, /function capturedRunTime\(now: \(\) => Date\): CapturedRunTime/, 'D20 3D must capture one exact governance clock before preflight, audit, and quota')
  assert.match(threeDRegistry, /now: runTime\.now/, 'D20 3D must pass the frozen clock snapshot into the connector context')
  assert.match(threeDRegistry, /occurredAt: runTime\.iso/, 'D20 3D must bind requested and terminal audit events to that one timestamp')
  assert.match(threeDAudit, /previousOccurredAt !== null && occurredAt < previousOccurredAt/, 'D20 3D must reject durable audit clock rollback')
  assert.match(threeDAudit, /occurredAt < requested\.occurredAt/, 'D20 3D must reject a terminal audit event that predates its request')
  assert.match(threeDAudit, /verifiedAuditChainHead\(\[\.\.\.priorValues, \{ event, previousHash, hash \}\]\)/, 'D20 3D must verify a prospective durable audit link before writing it')

  const market = sourceAt(snapshot('RA market'), 'src/gcl/market.ts')
  assert.match(market, /function validatedRequest\(config: SyntheticMarketConnectorConfig \| null, input: unknown, ctx: ConnectorRunContext\)/, 'D20 market must retain an unavailable configuration state through direct validation')
  assert.match(market, /function configured\(config: SyntheticMarketConnectorConfig \| null, ctx: ConnectorRunContext\): ConfiguredMarketLimits\s+\{\s+if \(!config\) throw new ConnectorUnavailableError\('MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED'\)/, 'D20 market must fail closed when the frozen constructor configuration is unavailable')

  const translation = snapshot('Translation')
  const translationConnector = sourceAt(translation, translation.connectorPath)
  const translationAudit = sourceAt(translation, 'src/gcl/audit.ts')
  assert.match(translationConnector, /if \(Object\.hasOwn\(config, 'liveOptInRequested'\)\) throw new ConnectorUnavailableError\('TRANSLATION_LIVE_EXECUTION_FORBIDDEN'\)/, 'D20 translation must reject even a false-valued live-opt-in configuration surface')
  assert.match(translationConnector, /\.\.\.\(liveOptInWasProvided \? \{ liveOptInRequested: true \} : \{\}\)/, 'D20 translation must avoid introducing a live-opt-in property when no environment surface exists')
  assert.match(translationAudit, /artifactProposalDetail\(value\.connectorId, value\.detail\.artifact\)\s+&& before\(value\.occurredAt, value\.detail\.artifact\.reviewExpiresAt\)/, 'D20 translation must reject a hash-valid success event with expired review authority')

  const language = sourceAt(snapshot('Language education'), 'src/gcl/language-education.ts')
  assert.match(language, /const input = exact\(value, \['synthetic', 'familyBriefRef', 'familyBriefHash', 'locale', 'activity'\]\)/, 'D20 language education must accept only the bounded family-brief fixture pointer')
  assert.match(language, /readonly scopes = \['langedu:family-brief:review'\] as const/, 'D20 language education must require a distinct family-brief review scope')
  assert.match(language, /delivery: 'SYNTHETIC_REFERENCE_ONLY'/, 'D20 language education must return only a synthetic reference')
  assert.match(language, /engagement: 'NO_GUARDIAN_OR_LEARNER_RESPONSE_PROFILE_OR_RECOMMENDATION'/, 'D20 language education must deny guardian or learner profiling/recommendation')
  assert.doesNotMatch(language, /(?:familyPrompt|familyResponse|guardianIdentity|guardianConsent|learnerProfile)/, 'D20 language education must not add family prompts, responses, or identity/profile fields')

  const camera = snapshot('Camera')
  const cameraAudit = sourceAt(camera, 'src/gcl/audit.ts')
  const cameraRegistry = sourceAt(camera, 'src/gcl/registry.ts')
  assert.match(cameraAudit, /export function validateAuditChainHead\(value: unknown\): Readonly<AuditRecordValue>/, 'D20 camera must validate the bounded durable audit head')
  assert.match(cameraAudit, /nodeTypes\.isProxy\(value\)/, 'D20 camera must deny a Proxy durable audit head before inspection')
  assert.match(cameraAudit, /Object\.getOwnPropertyNames\(value\)/, 'D20 camera must reject hidden durable-head fields')
  assert.match(cameraAudit, /if \(hash !== hashAuditEvent\(event, previousHash\)\) throw new AuditChainError\(\)/, 'D20 camera must bind a durable head to its sealed event and predecessor')
  assert.match(cameraAudit, /const previousHash = previous \? validateAuditChainHead\(previous\.values\)\.hash : null/, 'D20 camera must reject a malformed durable head before a successor write')
  assert.match(cameraRegistry, /error instanceof AuditReceiptError \|\| error instanceof AuditEventError \|\| error instanceof AuditChainError/, 'D20 camera must not manufacture a follow-up failed transition after a malformed durable audit head')
})

test('D21 direct-successor package preserves immutable lineage and inherited governance classifications', () => {
  const d21 = snapshots.filter((snapshot) => snapshot.batch === 'D21')
  assert.equal(d21.length, 8, 'D21 must cover the eight direct successor packages')

  for (const snapshot of d21) {
    const parent = snapshots.find((candidate) => candidate.batch === 'D20' && candidate.name === snapshot.name)
    assert.ok(parent, `D21 ${snapshot.name} must have a D20 package counterpart`)
    assert.equal(snapshot.parentRevision, parent.revision, `D21 ${snapshot.name} must name the exact D20 parent`)
    assert.equal(snapshot.hardDeniesLiveOptIn, parent.hardDeniesLiveOptIn, `D21 ${snapshot.name} must not reclassify its live-disable boundary`)
    assert.equal(snapshot.quotaFailureAudited, parent.quotaFailureAudited, `D21 ${snapshot.name} must not reclassify its quota-failure audit boundary`)
    assert.equal(snapshot.strictOwnerApproval, parent.strictOwnerApproval, `D21 ${snapshot.name} must not reclassify its owner-gate boundary`)
    assert.equal(strictOwnerApprovalGate(sourceAt(snapshot, 'src/gcl/registry.ts')), snapshot.strictOwnerApproval, `${snapshot.name} strict owner-approval classification changed`)
  }

  const d20Image = snapshots.find((snapshot) => snapshot.batch === 'D20' && snapshot.name === 'RA image')
  const d21Image = d21.find((snapshot) => snapshot.name === 'RA image')
  assert.ok(d20Image && d21Image, 'D20 and D21 RA image snapshots must be present')
  assert.equal(sourceAt(d21Image, d21Image.connectorPath), sourceAt(d20Image, d20Image.connectorPath), 'D21 RA image must not overstate a documentation-only change as new connector behaviour')
  assert.equal(sourceAt(d21Image, 'src/gcl/registry.ts'), sourceAt(d20Image, 'src/gcl/registry.ts'), 'D21 RA image must not overstate a documentation-only change as new runner behaviour')
})

test('D21 immutable boundaries reject omitted integrity bindings, shaped host seams, decision inputs, and malformed append witnesses', () => {
  const snapshot = (name: string): Snapshot => {
    const found = snapshots.find((candidate) => candidate.batch === 'D21' && candidate.name === name)
    assert.ok(found, `D21 ${name} snapshot must be present`)
    return found
  }

  const ocr = sourceAt(snapshot('RA OCR'), 'src/gcl/vision.ts')
  assert.match(ocr, /exactKeys\(proposal\.reviewPacket, \[[^\]]*'dateArithmeticBoundaryBinding'/, 'D21 OCR must reject a review packet that omits or hides the checked-date-arithmetic binding')
  assert.match(ocr, /const dateArithmeticBoundaryBinding = reviewedDateArithmeticBoundaryBinding\(proposal\.reviewPacket\.dateArithmeticBoundaryBinding\)/, 'D21 OCR must independently validate the date-arithmetic binding before review')
  assert.match(ocr, /reviewPacket\.proxyBoundaryBinding, reviewPacket\.dateArithmeticBoundaryBinding, reviewPacket\.evidenceBinding/, 'D21 OCR must include date-arithmetic evidence in the recomputed review-packet digest')

  const threeDAudit = sourceAt(snapshot('RA 3D/game'), 'src/gcl/audit.ts')
  assert.match(threeDAudit, /const requestedEvents = new Map<string, \{ event: ConnectorAuditEvent; occurredAt: number \}>\(\)/, 'D21 3D must retain a per-request temporal audit boundary')
  assert.match(threeDAudit, /occurredAt < requested\.occurredAt/, 'D21 3D must reject a terminal audit event that predates its own request')
  assert.match(threeDAudit, /terminalRequests\.has\(requestedAuditHash\)/, 'D21 3D must still reject a second terminal event for one request')
  assert.doesNotMatch(threeDAudit, /previousOccurredAt/, 'D21 3D must not reject a valid concurrent run merely because another run has a later wall-clock event')

  const market = snapshot('RA market')
  const marketRegistry = sourceAt(market, 'src/gcl/registry.ts')
  assert.match(marketRegistry, /function hostMethod<TArgument>\(value: unknown, member: string, error: string\)/, 'D21 market must bind host collaborators at construction')
  assert.match(marketRegistry, /nodeTypes\.isProxy\(value\)/, 'D21 market must reject a Proxy host collaborator before member lookup')
  assert.match(marketRegistry, /Object\.getOwnPropertyDescriptor\(current, member\)/, 'D21 market must read a host method only from a data descriptor')
  assert.match(marketRegistry, /function auditAppendResult\(value: unknown\): \{ hash: string \}/, 'D21 market must validate a host audit receipt before use')
  assert.match(marketRegistry, /names\.length !== 1 \|\| names\[0\] !== 'hash'/, 'D21 market must reject a shaped, accessor, or extra-field audit receipt')
  assert.match(marketRegistry, /const occurredAt = governedRunTime\(this\.runClock\)\s+const localNow = \(\) => new Date\(occurredAt\.getTime\(\)\)/, 'D21 market must copy one validated clock before preflight, audit, or quota')
  assert.match(marketRegistry, /auditAppendResult\(await this\.auditAppend\(\{/, 'D21 market must fail closed on an invalid audit result before treating a lifecycle transition as valid')

  const rfid = sourceAt(snapshot('RFID'), 'src/gcl/rfid.ts')
  assert.match(rfid, /exactObject\(value, \['synthetic', 'scenario', 'siteRef', 'ownerDecisionBoundaryFixture'\]/, 'D21 RFID must accept only a fixed owner-decision-boundary fixture pointer')
  assert.match(rfid, /execution: 'SYNTHETIC_OWNER_DECISION_BOUNDARY_REVIEW_PROPOSAL_ONLY_NOT_EXECUTED'/, 'D21 RFID owner-decision boundary must remain proposal-only')
  assert.match(rfid, /ownerDecisionInput: 'NOT_ACCEPTED'/, 'D21 RFID must reject owner-decision or attestation input')
  assert.match(rfid, /pilotLiveOrProductionEnablement: 'FORBIDDEN'/, 'D21 RFID must not authorize a pilot, live mode, or production')
  assert.match(rfid, /automaticAction: false/, 'D21 RFID owner-decision boundary must not execute an action')

  const translation = snapshot('Translation')
  const translationContext = sourceAt(translation, 'src/gcl/context.ts')
  const translationRegistry = sourceAt(translation, 'src/gcl/registry.ts')
  const translationAudit = sourceAt(translation, 'src/gcl/audit.ts')
  const translationArtifacts = sourceAt(translation, 'src/gcl/translation-artifacts.ts')
  assert.match(translationContext, /const PRODUCT_ID = \/\^sectrai-/, 'D21 translation must use a dedicated Sectrai product authority envelope')
  assert.match(translationContext, /export function requireGclTenantContext\(/, 'D21 translation must expose one fail-closed tenant-context assertion')
  assert.doesNotMatch(translationContext, /\.trim\(/, 'D21 translation must not broaden product/workspace authority by trimming it')
  assert.match(translationRegistry, /requireGclTenantContext\(request\)\s+if \(!request\.ownerApproved\)/, 'D21 translation must reject malformed tenant context before owner/preflight processing')
  assert.match(translationAudit, /!validGclTenantContext\(value\)/, 'D21 translation must reject malformed tenant data before an audit event is accepted')
  assert.match(translationArtifacts, /requireGclTenantContext\(input\)/, 'D21 translation artifact mutation paths must reject malformed tenant context')

  const language = sourceAt(snapshot('Language education'), 'src/gcl/language-education.ts')
  assert.match(language, /const input = exact\(value, \['synthetic', 'safetyRef', 'safetyHash', 'locale', 'activity'\]\)/, 'D21 language education must accept only a bounded safety-fixture pointer')
  assert.match(language, /readonly scopes = \['langedu:learning-safety:review'\] as const/, 'D21 language education must require a distinct safety review scope')
  assert.match(language, /safeguarding: 'NO_INCIDENT_REPORT_RISK_CLASSIFICATION_OR_ESCALATION'/, 'D21 language education must not process incidents, classify risk, or escalate')
  assert.match(language, /function ownEnvironmentSetting\(environment: unknown, name: string\)/, 'D21 language education must isolate environment configuration behind an own-data boundary')
  assert.match(language, /types\.isProxy\(environment\)/, 'D21 language education must reject a Proxy environment before reading a gate')
  assert.match(language, /syntheticEnabled: syntheticEnabled\.value === 'true' && !liveOptIn\.provided/, 'D21 language education must make a present live-enable field a fail-closed poison pill')
  assert.doesNotMatch(language, /environment\.GCL_LANGEDU_/, 'D21 language education must not read an inherited or accessor-backed environment gate directly')

  const camera = snapshot('Camera')
  const cameraAudit = sourceAt(camera, 'src/gcl/audit.ts')
  const cameraRegistry = sourceAt(camera, 'src/gcl/registry.ts')
  assert.match(cameraAudit, /const AUDIT_APPEND_RECEIPT_FIELDS = \['hash', 'previousHash'\] as const/, 'D21 camera append receipts must bind both the event hash and predecessor')
  assert.match(cameraAudit, /return Object\.freeze\(\{ hash: hash\.value, previousHash: previousHash\.value \}\)/, 'D21 camera must copy a bounded append witness before use')
  assert.match(cameraAudit, /receipt\.hash !== hashAuditEvent\(sealedEvent, receipt\.previousHash\)/, 'D21 camera must re-hash the sealed event against the returned predecessor')
  assert.match(cameraRegistry, /requestedAudit\.hash\)\s+return \{ \.\.\.result/, 'D21 camera success must pin its append witness to the requested event')
  assert.match(cameraRegistry, /requestedAudit\.hash\)\s+throw error/, 'D21 camera failure must pin its append witness to the requested event')
  assert.match(cameraRegistry, /error instanceof AuditReceiptError \|\| error instanceof AuditEventError \|\| error instanceof AuditChainError/, 'D21 camera must stop after an invalid append witness instead of inventing a follow-up transition')
})
