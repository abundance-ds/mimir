import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export default defineEventHandler(async (event) => {
  const { jti } = await readBody(event)
  if (!jti || typeof jti !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'jti is required' })
  }

  const revokedPath = join(process.cwd(), 'server/data/revoked.json')
  let revoked
  try { revoked = JSON.parse(readFileSync(revokedPath, 'utf8')) }
  catch { revoked = [] }

  if (!revoked.includes(jti)) {
    revoked.push(jti)
    mkdirSync(dirname(revokedPath), { recursive: true })
    writeFileSync(revokedPath, JSON.stringify(revoked, null, 2) + '\n')
  }

  return { ok: true }
})
