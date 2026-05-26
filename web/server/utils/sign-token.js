import { createPrivateKey, sign, randomUUID } from 'node:crypto'

let _privKey = null
function getPrivateKey() {
  if (_privKey) return _privKey
  const b64 = useRuntimeConfig().portalSigningKey
  if (!b64) return null
  const der = Buffer.from(b64, 'base64')
  _privKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  return _privKey
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function canSign() {
  return !!getPrivateKey()
}

export function signToken(payload) {
  const privateKey = getPrivateKey()
  if (!privateKey) throw createError({ statusCode: 500, statusMessage: 'Signing key not configured' })

  const segments = [
    base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })),
    base64url(JSON.stringify(payload)),
  ]
  const sig = sign(null, Buffer.from(segments.join('.')), privateKey)
  segments.push(base64url(sig))
  return segments.join('.')
}

export function issueClientToken({ name, platforms, expiresInSeconds }) {
  const now = Math.floor(Date.now() / 1000)
  const sub = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const jti = randomUUID().slice(0, 8)
  const payload = { sub, name, platforms, iat: now, exp: now + expiresInSeconds, jti }
  const token = signToken(payload)
  return { token, jti, sub, exp: now + expiresInSeconds }
}
