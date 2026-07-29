import assert from 'node:assert/strict'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { main, tokenFromText } from './admin_token.mjs'

test('reads quoted and unquoted token values', () => {
  assert.equal(tokenFromText('A=1\nMIMIR_CHAT_ADMIN_TOKEN=abc\n'), 'abc')
  assert.equal(tokenFromText('MIMIR_CHAT_ADMIN_TOKEN="quoted"\n'), 'quoted')
})

test('creates once, preserves unrelated env values, and exports without printing the token', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const env = join(tmpdir(), `mimir-admin-env-${suffix}`)
  const exported = join(tmpdir(), `mimir-admin-export-${suffix}`)
  await writeFile(env, 'OTHER=value\n')
  const originalLog = console.log
  const logs = []
  console.log = value => logs.push(String(value))
  try {
    await main(['--env', env, '--export', exported])
    const first = tokenFromText(await readFile(env, 'utf8'))
    await main(['--env', env, '--export', exported])
    const second = tokenFromText(await readFile(env, 'utf8'))
    assert.equal(first, second)
    assert.ok(first.length >= 32)
    assert.doesNotMatch(first, /\s/)
    assert.equal((await readFile(exported, 'utf8')).trim(), first)
    assert.match(await readFile(env, 'utf8'), /^OTHER=value$/m)
    assert.ok(logs.every(line => !line.includes(first)))
    assert.equal((await stat(env)).mode & 0o777, 0o600)
    assert.equal((await stat(exported)).mode & 0o777, 0o600)
  } finally {
    console.log = originalLog
    await Promise.all([
      unlink(env).catch(() => {}),
      unlink(exported).catch(() => {}),
    ])
  }
})
