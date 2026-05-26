import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let _pubKey = null
function getPublicKey() {
  if (_pubKey) return _pubKey
  const pem = readFileSync(join(process.cwd(), 'server/data/portal.pub'), 'utf-8')
  _pubKey = createPublicKey(pem)
  return _pubKey
}

function getRevoked() {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'server/data/revoked.json'), 'utf-8'))
  } catch {
    return []
  }
}

function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * @param {string} token - raw JWT string
 * @returns {{ sub: string, name?: string, platforms?: string[], role?: string, exp: number, jti: string }}
 * @throws on invalid signature, expired, or revoked
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw createError({ statusCode: 403, statusMessage: 'Missing token' })
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  const [headerB64, payloadB64, signatureB64] = parts

  let header
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString())
  } catch {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  if (header.alg !== 'EdDSA') {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  const pubKey = getPublicKey()
  const data = Buffer.from(`${headerB64}.${payloadB64}`)
  const signature = base64urlDecode(signatureB64)

  let valid
  try {
    valid = verify(null, data, pubKey, signature)
  } catch {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  if (!valid) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  let payload
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString())
  } catch {
    throw createError({ statusCode: 403, statusMessage: 'Invalid token' })
  }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw createError({ statusCode: 403, statusMessage: 'Token expired' })
  }

  const revoked = getRevoked()
  if (payload.jti && revoked.includes(payload.jti)) {
    throw createError({ statusCode: 403, statusMessage: 'Token revoked' })
  }

  return payload
}
