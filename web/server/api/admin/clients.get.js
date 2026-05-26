import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) }
  catch { return [] }
}

export default defineEventHandler(() => {
  const clientsPath = join(process.cwd(), 'server/data/clients.json')
  const revokedPath = join(process.cwd(), 'server/data/revoked.json')

  if (!canSign()) {
    return { canSign: false, clients: [] }
  }

  const clients = readJson(clientsPath)
  const revokedSet = new Set(readJson(revokedPath))
  const now = Math.floor(Date.now() / 1000)

  const enriched = clients.map(c => {
    const expEpoch = new Date(c.expiresAt + 'T00:00:00Z').getTime() / 1000
    let status = 'active'
    if (revokedSet.has(c.jti)) status = 'revoked'
    else if (expEpoch < now) status = 'expired'
    return { ...c, status }
  })

  return { canSign: true, clients: enriched }
})
