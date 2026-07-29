#!/usr/bin/env node
/** Create or export the gitignored Mimir Chat administration token. */

import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = 'MIMIR_CHAT_ADMIN_TOKEN'
const DEFAULT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env')

export function tokenFromText(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${KEY}=`)) continue
    let value = line.slice(KEY.length + 1).trim()
    if (
      value.length >= 2
      && value[0] === value.at(-1)
      && (value[0] === "'" || value[0] === '"')
    ) {
      value = value.slice(1, -1)
    }
    return value
  }
  return ''
}

async function writeAtomic(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = resolve(dirname(path), `.${basename(path)}.tmp.${process.pid}`)
  let handle
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function parseArgs(argv) {
  const options = { env: DEFAULT_ENV, exportPath: null }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || !['--env', '--export'].includes(flag)) {
      throw new Error(`unknown or incomplete argument: ${flag ?? ''}`)
    }
    if (flag === '--env') options.env = resolve(value)
    else options.exportPath = resolve(value)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const existing = await readFile(options.env, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  let token = tokenFromText(existing)
  if (token && (token.length < 32 || /\s/.test(token))) {
    throw new Error(`${KEY} must be at least 32 characters without whitespace`)
  }
  if (!token) {
    token = randomBytes(48).toString('base64url')
    const separator = !existing || existing.endsWith('\n') ? '' : '\n'
    await writeAtomic(options.env, `${existing}${separator}${KEY}=${token}\n`)
  } else {
    await chmod(options.env, 0o600)
  }
  if (options.exportPath) await writeAtomic(options.exportPath, `${token}\n`)
  console.log(`${KEY} is ready in ${options.env}`)
}

const isEntryPoint = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
