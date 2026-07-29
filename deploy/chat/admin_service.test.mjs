import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  AdminError,
  containsAny,
  createAdminServer,
  isMainModule,
  normalizeAccount,
  normalizeChannel,
  normalizeTopic,
} from './admin_service.mjs'

class FakeBackend {
  constructor() {
    this.added = []
  }

  async state() {
    return {
      users: [{ account: 'waqr', active: true, protected: true }],
      channels: [],
      retiredChannels: [],
    }
  }

  async addUser(account) {
    const normalized = normalizeAccount(account)
    this.added.push(normalized)
    return { account: normalized, passphrase: 'generated-test-passphrase' }
  }
}

describe('chat administration HTTP service', () => {
  let backend
  let base
  let server
  const token = 'test-token-with-more-than-thirty-two-characters'

  beforeEach(async () => {
    backend = new FakeBackend()
    server = createAdminServer({
      tokenDigest: createHash('sha256').update(token).digest(),
      backend,
      page: Buffer.from('<!doctype html><title>Mimir Chat administration</title>'),
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  test('serves the page publicly but requires the exact token for state', async () => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Mimir Chat administration/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)

    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    assert.equal((await fetch(`${base}/api/state`, {
      headers: { Authorization: 'Bearer wrong' },
    })).status, 401)

    const state = await fetch(`${base}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(state.status, 200)
    assert.equal((await state.json()).result.users[0].account, 'waqr')
  })

  test('validates a mutation and returns its one-time passphrase', async () => {
    const response = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account: 'Anna' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).result, {
      account: 'anna',
      passphrase: 'generated-test-passphrase',
    })
    assert.deepEqual(backend.added, ['anna'])
  })

  test('rejects malformed and oversized mutation bodies without calling the backend', async () => {
    const invalid = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{',
    })
    assert.equal(invalid.status, 400)

    const oversized = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account: 'a'.repeat(17_000) }),
    })
    assert.equal(oversized.status, 413)
    assert.deepEqual(backend.added, [])
  })

  test('serializes backend work while leaving the health endpoint responsive', async () => {
    let releaseState
    backend.state = () => new Promise(resolve => {
      releaseState = () => resolve({
        users: [],
        channels: [],
        retiredChannels: [],
      })
    })
    const pending = fetch(`${base}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    while (!releaseState) await new Promise(resolve => setImmediate(resolve))

    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    releaseState()
    assert.equal((await pending).status, 200)
  })
})

test('product identifiers are narrow and normalized', () => {
  assert.equal(normalizeAccount(' Anna '), 'anna')
  assert.equal(normalizeChannel('Project.One'), '#project.one')
  assert.equal(normalizeTopic('  launch\n plan  '), 'launch plan')
  assert.throws(() => normalizeAccount('space name'), AdminError)
  assert.throws(() => normalizeChannel('#bad/channel'), AdminError)
})

test('IRC success alternatives are alternatives', () => {
  assert.equal(containsAny([':server 381 nick :You are now an IRC operator'], [
    ' 381 ',
    'already opered-up',
  ]), true)
})

test('direct launch detection follows a release symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mimir-admin-entry-'))
  const link = join(directory, 'admin_service.mjs')
  const moduleUrl = new URL('./admin_service.mjs', import.meta.url)
  try {
    await symlink(new URL(moduleUrl), link)
    assert.equal(isMainModule(moduleUrl.href, link), true)
  } finally {
    await unlink(link).catch(() => {})
    await import('node:fs/promises').then(({ rmdir }) => rmdir(directory))
  }
})
