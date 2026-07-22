import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

type AuditBatch = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9' | 'D10' | 'D11' | 'D12' | 'D13' | 'D14'

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
  directory: string
  connectorPath: string
  connectorBlob: string
  registryBlob: string
  hardDeniesLiveOptIn: boolean
  quotaFailureAudited: boolean
  /** A package module gets an exact blob pin in addition to its closure scan. */
  pinnedClosureBlobs?: readonly PinnedClosureBlob[]
  /** A package companion requires review even when it is not imported by the public connector. */
  pinnedSupplementalBlobs?: readonly PinnedSupplementalBlob[]
}

const AUDIT_WORKTREE_ROOT = '/home/tayla/projects/_wt'
const GCL_ROOT = 'src/gcl/'
/** `node:util` is limited to Camera's in-process proxy detection. */
const ALLOWED_NONLOCAL_GCL_IMPORTS = new Set(['node:crypto', 'node:util'])
/** Prisma is permitted only as an erased TypeScript type import in the local persistence seam. */
const ALLOWED_TYPE_ONLY_GCL_IMPORTS = new Set(['@prisma/client'])

/*
 * These are immutable local Git snapshots from the D1 through D14 audit batches.
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

function assertNoRuntimeEscape(source: string, name: string): void {
  const code = sourceCode(source)
  assertNoProcessEnvironmentEscape(code, name)
  assertNoFunctionCapability(source, name)
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

function auditCapturesQuotaFailure(registry: string): boolean {
  const requestedAudit = registry.indexOf('const requestedAudit')
  const protectedExecution = registry.indexOf('try {', requestedAudit)
  const quota = registry.indexOf('await this.quota.consume', requestedAudit)
  const failureAudit = Math.max(
    registry.indexOf("type: 'connector.run.failed'", quota),
    registry.indexOf("this.event('connector.run.failed'", quota),
  )
  const failureSource = registry.slice(failureAudit)
  const directRequestedLink = failureSource.includes('requestedAuditHash: requestedAudit.hash')
  const helperCall = failureSource.match(/\bdetail\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\(\s*requestedAudit\.hash\b/)
  const helperName = helperCall?.[1]
  const helperStart = helperName ? registry.indexOf(`function ${helperName}(`) : -1
  const helperEnd = helperStart >= 0 ? registry.indexOf('\n}', helperStart) : -1
  const helperSource = helperEnd >= 0 ? registry.slice(helperStart, helperEnd) : ''
  const helperForwardsRequestedLink = Boolean(helperName)
    && /^function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*requestedAuditHash\b/.test(helperSource)
    && /\brequestedAuditHash\s*(?::|[,}])/.test(helperSource)
  return requestedAudit >= 0 && protectedExecution > requestedAudit && protectedExecution < quota && failureAudit > quota && (directRequestedLink || helperForwardsRequestedLink)
}

function hardDeniesLiveOptIn(connector: string): boolean {
  const directRejection = /if \((?:this\.)?config\.liveEnabled(?:\)| !== false\)) throw new ConnectorUnavailableError/.test(connector)
  const environmentPoisonPill = /Object\.hasOwn\(environment, 'GCL_[A-Z0-9_]+_LIVE_ENABLED'\)/.test(connector)
    && /syntheticEnabled:\s*environment\.GCL_[A-Z0-9_]+_SYNTHETIC_ENABLED\s*===\s*'true'\s*&&\s*!liveOptInWasProvided/.test(connector)
  return directRejection || environmentPoisonPill
}

function ownerDenialPrecedesReservations(registry: string): boolean {
  const ownerGate = registry.search(/if \((?:!(?:request|context|safeRequest)\.ownerApproved|(?:request|context|safeRequest)\.ownerApproved !== true)\) throw new OwnerGateError/)
  const preflight = registry.indexOf('await connector.preflight')
  const requestedAudit = registry.indexOf('const requestedAudit')
  const quota = registry.indexOf('await this.quota.consume')
  return ownerGate >= 0 && ownerGate < preflight && preflight < requestedAudit && requestedAudit < quota
}

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14 source fixture pins every audited connector and its governance runner to local Git objects', () => {
  for (const snapshot of snapshots) {
    const resolvedRevision = gitAt(snapshot, ['rev-parse', '--verify', `${snapshot.revision}^{commit}`]).trim()
    assert.equal(resolvedRevision.startsWith(snapshot.revision), true, `${snapshot.name} revision does not resolve to its pinned commit`)
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

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14 synthetic source closure has no egress, privileged configuration, subprocess, or send surface', () => {
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

test('D1/D2/D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14 denied-owner and quota-rejection edge cases are classified without overstating conformance', () => {
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
