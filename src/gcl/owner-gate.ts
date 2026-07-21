import { ConnectorUnavailableError, OwnerGateError } from './errors.js'

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
}

/** Returns an error without revealing whether a supplied token was close. */
export function ownerGateError(expectedToken: string | undefined, suppliedToken: string | undefined): ConnectorUnavailableError | OwnerGateError | null {
  if (!expectedToken) return new ConnectorUnavailableError('GCL_OWNER_GATE_NOT_CONFIGURED')
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) return new OwnerGateError()
  return null
}
