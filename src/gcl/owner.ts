function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
}

/** Missing or mismatched owner credentials always reject without revealing why. */
export function ownerTokenMatches(expectedToken: string | undefined, suppliedToken: string | undefined): boolean {
  return Boolean(expectedToken && suppliedToken && constantTimeEqual(suppliedToken, expectedToken))
}
