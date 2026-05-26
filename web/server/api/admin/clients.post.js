import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DURATIONS = { '7d': 604800, '30d': 2592000, '90d': 7776000, '180d': 15552000, '365d': 31536000 }

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) }
  catch { return [] }
}

export default defineEventHandler(async (event) => {
  const { name, platforms, expiresIn } = await readBody(event)

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Name is required' })
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'At least one platform required' })
  }

  const seconds = DURATIONS[expiresIn] || DURATIONS['365d']
  const { token, jti, sub, exp } = issueClientToken({
    name: name.trim(),
    platforms,
    expiresInSeconds: seconds,
  })

  const clientsPath = join(process.cwd(), 'server/data/clients.json')
  const clients = readJson(clientsPath)
  clients.push({
    jti,
    sub,
    name: name.trim(),
    platforms,
    issuedAt: new Date().toISOString().slice(0, 10),
    expiresAt: new Date(exp * 1000).toISOString().slice(0, 10),
    token,
  })
  mkdirSync(dirname(clientsPath), { recursive: true })
  writeFileSync(clientsPath, JSON.stringify(clients, null, 2) + '\n')

  const url = `https://v3.shoulde.rs/download?key=${token}`
  return { url, jti }
})
