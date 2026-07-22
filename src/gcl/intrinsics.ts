import { types as nodeTypes } from 'node:util'

/**
 * D24 captures the small set of host-language primitives that define the
 * governed runner's local timestamp and registration/collaborator boundaries.
 * This is not a clean-realm attestation; it only excludes hooks added after
 * this module was initialized from retargeting those local checks.
 */
export const intrinsicArrayIsArray = Array.isArray
export const intrinsicArrayIncludes = Array.prototype.includes
export const intrinsicArrayMap = Array.prototype.map
export const intrinsicArrayPrototype = Array.prototype
export const intrinsicArraySort = Array.prototype.sort
export const intrinsicDate = Date
export const intrinsicDateGetTime = Date.prototype.getTime
export const intrinsicDateToISOString = Date.prototype.toISOString
export const intrinsicIsDate = nodeTypes.isDate
export const intrinsicIsProxy = nodeTypes.isProxy
export const intrinsicJsonStringify = JSON.stringify
export const intrinsicNumber = Number
export const intrinsicNumberIsFinite = Number.isFinite
export const intrinsicNumberIsNaN = Number.isNaN
export const intrinsicNumberIsSafeInteger = Number.isSafeInteger
export const intrinsicObjectCreate = Object.create
export const intrinsicObjectEntries = Object.entries
export const intrinsicObjectFreeze = Object.freeze
export const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
export const intrinsicObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
export const intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames
export const intrinsicObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols
export const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf
export const intrinsicObjectPrototype = Object.prototype
export const intrinsicReflectApply = Reflect.apply
export const intrinsicSet = Set
export const intrinsicSetAdd = Set.prototype.add
export const intrinsicSetDelete = Set.prototype.delete
export const intrinsicSetHas = Set.prototype.has
export const intrinsicStringCharCodeAt = String.prototype.charCodeAt
export const intrinsicStringLocaleCompare = String.prototype.localeCompare
