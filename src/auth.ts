import type { NextFunction, Request, Response } from 'express'

const productPattern = /^sectrai-[a-z0-9-]{1,80}$/

export function productKeyEnvironmentName(product: string): string | null {
  if (!productPattern.test(product)) return null
  const suffix = product.slice('sectrai-'.length).replaceAll('-', '_').toUpperCase()
  return `SHARED_API_KEY_${suffix}`
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
}

export function productAuth(request: Request, response: Response, next: NextFunction): void {
  const product = typeof request.params.product === 'string' ? request.params.product : undefined
  const keyName = product ? productKeyEnvironmentName(product) : null
  const expected = keyName ? process.env[keyName] : undefined
  const supplied = request.header('x-sectrai-product-key')
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    response.status(401).json({ error: 'UNAUTHORIZED_PRODUCT_KEY', code: 'unauthorized_product_key' })
    return
  }
  next()
}

export function validProduct(product: string): boolean { return productPattern.test(product) }
