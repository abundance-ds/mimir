#!/usr/bin/env node
/**
 * Minimal token-authenticated administration for Mimir Chat.
 *
 * Every operation opens a fresh loopback IRC connection, authenticates a
 * dedicated service account with SASL, obtains its narrowly scoped OPER role,
 * performs one bounded operation, and disconnects.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { fileURLToPath } from 'node:url'

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_\-[\]{}^`]{0,31}$/
const CHANNEL = /^#[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
const TOKEN_HASH = /^[0-9a-f]{64}$/
const MAX_BODY_BYTES = 16 * 1024
const SYSTEM_ACCOUNTS = new Set(['mimir-admin'])
const PROTECTED_ACCOUNTS = new Set(['waqr', 'mimir-admin'])
const PROTECTED_CHANNELS = new Set(['#general'])
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
})

export class AdminError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'AdminError'
    this.status = status
  }
}

class IrcTimeoutError extends Error {
  constructor() {
    super('IRC response timed out')
    this.name = 'IrcTimeoutError'
  }
}

export class Irc {
  constructor(account, password, {
    host = '127.0.0.1',
    port = 16667,
    connectTimeoutMs = 5_000,
  } = {}) {
    this.account = account
    this.password = password
    this.nick = `mimir-admin-${randomBytes(3).toString('hex')}`
    this.host = host
    this.port = port
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.buffer = ''
    this.lines = []
    this.waiters = []
    this.failure = null
  }

  async open() {
    if (this.socket) return this

    const socket = connectSocket({ host: this.host, port: this.port })
    this.socket = socket
    socket.setEncoding('utf8')
    socket.setNoDelay(true)

    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', error => {
      this.failure = error
      this.rejectWaiters(error)
    })
    socket.on('close', () => {
      if (!this.failure) this.failure = new Error('IRC connection closed')
      this.rejectWaiters(this.failure)
    })

    await new Promise((resolve, reject) => {
      let settled = false
      const finish = callback => value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        callback(value)
      }
      const onConnect = finish(resolve)
      const onError = finish(reject)
      const timer = setTimeout(() => {
        const error = new IrcTimeoutError()
        socket.destroy(error)
        onError(error)
      }, this.connectTimeoutMs)
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })

    return this
  }

  receive(chunk) {
    this.buffer += chunk
    while (this.buffer.includes('\n')) {
      const newline = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.startsWith('PING ')) {
        try {
          this.send(`PONG ${line.slice(5)}`)
        } catch {
          // The socket failure is delivered to the active waiter.
        }
      }
      const waiter = this.waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(line)
      } else {
        this.lines.push(line)
      }
    }
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  send(line) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('IRC connection is not open')
    }
    if (/[\r\n]/.test(line)) {
      throw new TypeError('IRC commands cannot contain newlines')
    }
    this.socket.write(`${line}\r\n`)
  }

  readLine(timeoutMs) {
    if (this.lines.length) return Promise.resolve(this.lines.shift())
    if (this.failure) return Promise.reject(this.failure)

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        reject(new IrcTimeoutError())
      }, Math.max(1, timeoutMs))
      this.waiters.push(waiter)
    })
  }

  async waitFor(needles, timeoutMs = 10_000) {
    const loweredNeedles = needles.map(needle => needle.toLowerCase())
    const deadline = Date.now() + timeoutMs
    const lines = []

    while (Date.now() < deadline) {
      try {
        const line = await this.readLine(deadline - Date.now())
        lines.push(line)
        const lowered = line.toLowerCase()
        if (loweredNeedles.some(needle => lowered.includes(needle))) return lines
      } catch (error) {
        if (error instanceof IrcTimeoutError) break
        throw error
      }
    }
    return lines
  }

  async waitForMatches(pattern, count, timeoutMs = 10_000) {
    const expression = pattern instanceof RegExp
      ? new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`)
      : new RegExp(pattern, 'i')
    const deadline = Date.now() + timeoutMs
    const lines = []
    let matches = 0

    while (Date.now() < deadline && matches < count) {
      try {
        const line = await this.readLine(deadline - Date.now())
        lines.push(line)
        expression.lastIndex = 0
        if (expression.test(line)) matches += 1
      } catch (error) {
        if (error instanceof IrcTimeoutError) break
        throw error
      }
    }
    return lines
  }

  async authenticate() {
    this.send('CAP LS 302')
    this.send(`NICK ${this.nick}`)
    this.send(`USER ${this.nick} 0 * :Mimir Chat administration`)
    requireLines(await this.waitFor(['sasl']), ['sasl'], 'server did not offer SASL')

    this.send('CAP REQ :sasl')
    requireLines(
      await this.waitFor([' ack ', ' ack :', ' nak ', ' nak :']),
      ['ack', 'sasl'],
      'server did not acknowledge SASL',
    )
    this.send('AUTHENTICATE PLAIN')
    requireLines(
      await this.waitFor(['authenticate +']),
      ['authenticate +'],
      'server did not start SASL',
    )
    const payload = Buffer.from(`\0${this.account}\0${this.password}`).toString('base64')
    this.send(`AUTHENTICATE ${payload}`)
    const authenticated = await this.waitFor([' 903 ', ' 904 ', ' 905 ', ' 906 ', ' 907 '])
    requireLines(authenticated, [' 903 '], 'administration account SASL failed')

    this.send('CAP END')
    const welcome = await this.waitFor([' 001 '])
    requireLines(welcome, [' 001 '], 'administration IRC registration failed')
    for (const line of welcome) {
      const match = line.match(/ 001 ([^ ]+) /)
      if (match) {
        this.nick = match[1]
        break
      }
    }

    this.send(`OPER ${this.account} ${this.password}`)
    const oper = await this.waitFor([
      ' 381 ',
      'you are now an irc operator',
      'already opered-up',
      ' 400 ',
      ' 464 ',
      ' 481 ',
      ' 491 ',
    ])
    if (!containsAny(oper, [' 381 ', 'you are now an irc operator', 'already opered-up'])) {
      throw new AdminError('administration account could not obtain its OPER role', 502)
    }

    // Ergo auto-joins every account to #general. Keep this service identity
    // out of the visible teammate list even when always-on sessions are used.
    this.send('PART #general :administration service')
    await this.waitFor([' part #general', ' 442 '], 1_000)
  }

  async service(name, command, until) {
    this.send(`PRIVMSG ${name} :${command}`)
    return this.waitFor(until)
  }

  close() {
    if (!this.socket) return
    try {
      if (!this.socket.destroyed) {
        this.send('QUIT :administration operation complete')
        this.socket.end()
      }
    } catch {
      this.socket.destroy()
    }
  }

  async run(operation) {
    await this.open()
    try {
      await this.authenticate()
      return await operation(this)
    } finally {
      this.close()
    }
  }
}

export function containsAll(lines, needles) {
  const text = lines.join('\n').toLowerCase()
  return needles.every(needle => text.includes(needle.toLowerCase()))
}

export function containsAny(lines, needles) {
  const text = lines.join('\n').toLowerCase()
  return needles.some(needle => text.includes(needle.toLowerCase()))
}

function requireLines(lines, needles, message) {
  if (!containsAll(lines, needles)) throw new AdminError(message, 502)
}

export function normalizeAccount(value) {
  const account = String(value ?? '').trim().toLowerCase()
  if (!ACCOUNT.test(account)) {
    throw new AdminError(
      'Account must be 1–32 characters using letters, numbers, dashes, '
      + 'underscores, brackets, braces, ^, or `.',
    )
  }
  return account
}

export function normalizeChannel(value) {
  let channel = String(value ?? '').trim().toLowerCase()
  if (channel && !channel.startsWith('#')) channel = `#${channel}`
  if (!CHANNEL.test(channel)) {
    throw new AdminError(
      'Channel must start with # and use letters, numbers, dots, dashes, or underscores.',
    )
  }
  return channel
}

export function normalizeTopic(value) {
  const topic = String(value ?? '').replace(/[\r\n]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ')
  if (Buffer.byteLength(topic, 'utf8') > 300) {
    throw new AdminError('Topic must be at most 300 UTF-8 bytes.')
  }
  return topic
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function confirmationCode(lines, pattern, message) {
  const match = lines.join('\n').match(pattern)
  if (!match) throw new AdminError(message, 502)
  return match[1]
}

export class ErgoAdmin {
  constructor(account, password, options = {}) {
    this.account = account
    this.password = password
    this.ircOptions = options
  }

  connect() {
    return new Irc(this.account, this.password, this.ircOptions)
  }

  async withConnection(operation) {
    return this.connect().run(operation)
  }

  async state() {
    return this.withConnection(async irc => {
      const accountLines = await irc.service('NickServ', 'LIST', ['end of nickserv list'])
      const accounts = [...new Set(accountLines.flatMap(line => {
        const match = line.match(/NOTICE [^ ]+ :\s+([^ ]+)\s*$/)
        const account = match?.[1]?.toLowerCase()
        return account && !SYSTEM_ACCOUNTS.has(account) ? [account] : []
      }))].sort()

      const suspendedLines = await irc.service(
        'NickServ',
        'SUSPEND LIST',
        ['active account suspensions'],
      )
      const suspensionMatch = suspendedLines.join('\n').match(
        /There are (\d+) active account suspensions/i,
      )
      const suspensionCount = Number(suspensionMatch?.[1] ?? 0)
      if (suspensionCount) {
        suspendedLines.push(...await irc.waitForMatches(
          /Account [^ ]+ suspended at/i,
          suspensionCount,
          Math.min(10_000, (1 + suspensionCount) * 1_000),
        ))
      }
      const suspended = new Set(suspendedLines.flatMap(line => {
        const match = line.match(/Account ([^ ]+) suspended at/i)
        return match ? [match[1].toLowerCase()] : []
      }))

      const channelLines = await irc.service('ChanServ', 'LIST', ['end of chanserv list'])
      const channelNames = [...new Set(channelLines.flatMap(line => {
        const match = line.match(/NOTICE [^ ]+ :\s+(#[^ ]+)\s*$/)
        return match ? [match[1].toLowerCase()] : []
      }))].sort()
      const channels = []
      for (const channel of channelNames) {
        const info = await irc.service(
          'ChanServ',
          `INFO ${channel}`,
          ['registered at:', 'is not registered'],
        )
        const founder = info.join('\n').match(/Founder:\s*([^ \r\n]+)/i)?.[1]?.toLowerCase() ?? ''
        channels.push({
          name: channel,
          founder,
          protected: PROTECTED_CHANNELS.has(channel),
        })
      }

      const purgedLines = await irc.service(
        'ChanServ',
        'PURGE LIST',
        ['purged channel(s)'],
      )
      const purgeMatch = purgedLines.join('\n').match(/There are (\d+) purged channel/i)
      const purgeCount = Number(purgeMatch?.[1] ?? 0)
      if (purgeCount) {
        purgedLines.push(...await irc.waitForMatches(
          /NOTICE [^ ]+ :\d+:\s+#[^ ]+/i,
          purgeCount,
          Math.min(10_000, (1 + purgeCount) * 1_000),
        ))
      }
      const retiredChannels = [...new Set(purgedLines.flatMap(line => {
        const match = line.match(/:\d+:\s+(#[^ ]+)/)
        return match ? [match[1].toLowerCase()] : []
      }))].sort()

      return {
        users: accounts.map(account => ({
          account,
          active: !suspended.has(account),
          protected: PROTECTED_ACCOUNTS.has(account),
        })),
        channels,
        retiredChannels,
      }
    })
  }

  async addUser(rawAccount) {
    const account = normalizeAccount(rawAccount)
    if (PROTECTED_ACCOUNTS.has(account)) {
      throw new AdminError(`${account} is reserved`, 409)
    }
    const passphrase = randomBytes(32).toString('base64url')
    const result = await this.withConnection(irc => irc.service(
      'NickServ',
      `SAREGISTER ${account} ${passphrase}`,
      ['successfully registered account', 'already exists', 'already registered'],
    ))
    if (containsAny(result, ['already exists', 'already registered'])) {
      throw new AdminError(`Account ${account} already exists.`, 409)
    }
    requireLines(result, ['successfully registered account'], 'NickServ did not confirm account creation')
    return { account, passphrase }
  }

  async resetPassword(rawAccount) {
    const account = normalizeAccount(rawAccount)
    if (PROTECTED_ACCOUNTS.has(account)) {
      throw new AdminError('Protected account credentials are managed on the server.')
    }
    const passphrase = randomBytes(32).toString('base64url')
    const result = await this.withConnection(irc => irc.service(
      'NickServ',
      `PASSWD ${account} ${passphrase}`,
      ['password changed', 'account does not exist', 'insufficient privileges'],
    ))
    if (!containsAll(result, ['password changed'])) {
      throw new AdminError(`Could not reset ${account}; the account may not exist.`)
    }
    return { account, passphrase }
  }

  async deactivateUser(rawAccount) {
    const account = normalizeAccount(rawAccount)
    if (PROTECTED_ACCOUNTS.has(account)) {
      throw new AdminError('Protected accounts cannot be deactivated here.')
    }
    const result = await this.withConnection(irc => irc.service(
      'NickServ',
      `SUSPEND ADD ${account} Removed through Mimir administration`,
      ['successfully suspended account', 'no such account', 'an error occurred'],
    ))
    if (!containsAll(result, ['successfully suspended account'])) {
      throw new AdminError(`Could not deactivate ${account}; it may not exist or may already be inactive.`)
    }
    return { account }
  }

  async reactivateUser(rawAccount) {
    const account = normalizeAccount(rawAccount)
    const result = await this.withConnection(irc => irc.service(
      'NickServ',
      `SUSPEND DEL ${account}`,
      ['successfully un-suspended account', 'account was not suspended', 'no such account'],
    ))
    if (!containsAll(result, ['successfully un-suspended account'])) {
      throw new AdminError(`Could not reactivate ${account}; it may not be inactive.`)
    }
    return { account }
  }

  async deleteUser(rawAccount) {
    const account = normalizeAccount(rawAccount)
    if (PROTECTED_ACCOUNTS.has(account)) {
      throw new AdminError('Protected accounts cannot be deleted here.')
    }
    return this.withConnection(async irc => {
      const challenge = await irc.service(
        'NickServ',
        `UNREGISTER ${account}`,
        ['to confirm, run this command', 'invalid account name'],
      )
      if (containsAll(challenge, ['invalid account name'])) {
        throw new AdminError(`Account ${account} does not exist.`, 404)
      }
      const code = confirmationCode(
        challenge,
        new RegExp(`/NS\\s+UNREGISTER\\s+${escapeRegExp(account)}\\s+([A-Za-z0-9]+)`, 'i'),
        'NickServ did not provide an account-deletion confirmation',
      )
      const result = await irc.service(
        'NickServ',
        `UNREGISTER ${account} ${code}`,
        ['successfully unregistered account', 'error while unregistering account'],
      )
      requireLines(result, ['successfully unregistered account'], 'NickServ did not confirm account deletion')
      return { account }
    })
  }

  async createChannel(rawChannel, rawTopic, rawFounder) {
    const channel = normalizeChannel(rawChannel)
    if (PROTECTED_CHANNELS.has(channel)) {
      throw new AdminError(`${channel} already exists.`, 409)
    }
    const topic = normalizeTopic(rawTopic)
    const founder = normalizeAccount(rawFounder || 'waqr')
    return this.withConnection(async irc => {
      await this.join(irc, channel)
      try {
        const registered = await irc.service(
          'ChanServ',
          `REGISTER ${channel}`,
          ['successfully registered', 'already registered', 'must be an oper'],
        )
        if (!containsAll(registered, ['successfully registered'])) {
          throw new AdminError(`Channel ${channel} already exists or could not be registered.`)
        }
        if (topic) await this.setTopicOnConnection(irc, channel, topic, true)
        if (founder !== this.account) await this.transferOnConnection(irc, channel, founder)
      } finally {
        await this.part(irc, channel)
      }
      return { name: channel, founder }
    })
  }

  async setTopic(rawChannel, rawTopic) {
    const channel = normalizeChannel(rawChannel)
    const topic = normalizeTopic(rawTopic)
    return this.withConnection(async irc => {
      await this.join(irc, channel)
      try {
        await this.setTopicOnConnection(irc, channel, topic, false)
      } finally {
        await this.part(irc, channel)
      }
      return { name: channel, topic }
    })
  }

  async transferChannel(rawChannel, rawFounder) {
    const channel = normalizeChannel(rawChannel)
    const founder = normalizeAccount(rawFounder)
    return this.withConnection(async irc => {
      await this.transferOnConnection(irc, channel, founder)
      return { name: channel, founder }
    })
  }

  async retireChannel(rawChannel) {
    const channel = normalizeChannel(rawChannel)
    if (PROTECTED_CHANNELS.has(channel)) {
      throw new AdminError('The durable #general channel cannot be retired.')
    }
    return this.withConnection(async irc => {
      const challenge = await irc.service(
        'ChanServ',
        `PURGE ADD ${channel}`,
        ['to confirm, run this command'],
      )
      const code = confirmationCode(
        challenge,
        new RegExp(`/CS\\s+PURGE\\s+ADD\\s+${escapeRegExp(channel)}\\s+([A-Za-z0-9]+)`, 'i'),
        'ChanServ did not provide a channel-retirement confirmation',
      )
      const result = await irc.service(
        'ChanServ',
        `PURGE ADD ${channel} ${code}`,
        ['successfully purged channel', 'an error occurred'],
      )
      requireLines(result, ['successfully purged channel'], 'ChanServ did not confirm channel retirement')
      return { name: channel }
    })
  }

  async allowChannel(rawChannel) {
    const channel = normalizeChannel(rawChannel)
    const result = await this.withConnection(irc => irc.service(
      'ChanServ',
      `PURGE DEL ${channel}`,
      ['successfully unpurged channel', "wasn't previously purged"],
    ))
    requireLines(
      result,
      ['successfully unpurged channel'],
      'ChanServ did not confirm that the channel name is available again',
    )
    return { name: channel }
  }

  async join(irc, channel) {
    irc.send(`JOIN ${channel}`)
    const joined = await irc.waitFor([
      ` join ${channel}`,
      ' 443 ',
      ' 403 ',
      ' 473 ',
      ' 474 ',
      ' 475 ',
    ])
    if (!containsAny(joined, [` join ${channel}`, ' 443 '])) {
      throw new AdminError(`Administration service could not join ${channel}.`)
    }
  }

  async part(irc, channel) {
    irc.send(`PART ${channel} :administration complete`)
    await irc.waitFor([` part ${channel}`, ' 442 '], 2_000)
  }

  async setTopicOnConnection(irc, channel, topic, alreadyOperator) {
    if (!alreadyOperator) {
      irc.send(`SAMODE ${channel} +o ${irc.nick}`)
      const promoted = await irc.waitFor([` mode ${channel} +o `, ' 482 ', ' 403 '])
      if (!containsAll(promoted, [` mode ${channel} +o `])) {
        throw new AdminError(`Administration service could not edit ${channel}.`)
      }
    }
    irc.send(`TOPIC ${channel} :${topic}`)
    const changed = await irc.waitFor([` topic ${channel} `, ' 482 ', ' 403 '])
    if (!containsAll(changed, [` topic ${channel} `])) {
      throw new AdminError(`Ergo did not confirm the topic change for ${channel}.`)
    }
  }

  async transferOnConnection(irc, channel, founder) {
    const challenge = await irc.service(
      'ChanServ',
      `TRANSFER ${channel} ${founder}`,
      [
        'to confirm your channel transfer',
        'successfully transferred channel',
        'account does not exist',
        'channel does not exist',
      ],
    )
    if (containsAll(challenge, ['successfully transferred channel'])) return
    if (containsAll(challenge, ['account does not exist'])) {
      throw new AdminError(`Founder account ${founder} does not exist.`)
    }
    const code = confirmationCode(
      challenge,
      new RegExp(`/CS\\s+TRANSFER\\s+${escapeRegExp(channel)}\\s+${escapeRegExp(founder)}\\s+([A-Za-z0-9]+)`, 'i'),
      'ChanServ did not provide an ownership-transfer confirmation',
    )
    const result = await irc.service(
      'ChanServ',
      `TRANSFER ${channel} ${founder} ${code}`,
      ['successfully transferred channel', 'could not transfer channel'],
    )
    requireLines(
      result,
      ['successfully transferred channel'],
      'ChanServ did not confirm channel ownership transfer',
    )
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Length': String(body.length),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message })
}

function requireAuthentication(response) {
  response.writeHead(401, {
    ...SECURITY_HEADERS,
    'Content-Length': '0',
    'WWW-Authenticate': 'Bearer realm="Mimir Chat administration"',
  })
  response.end()
}

function authorized(request, expectedDigest) {
  const authorization = request.headers.authorization ?? ''
  if (!authorization.startsWith('Bearer ')) return false
  const token = authorization.slice('Bearer '.length).trim()
  if (!token) return false
  const digest = createHash('sha256').update(token).digest()
  return digest.length === expectedDigest.length && timingSafeEqual(digest, expectedDigest)
}

async function jsonBody(request) {
  const header = request.headers['content-length']
  if (header === undefined || !/^\d+$/.test(header)) {
    throw new AdminError('Content-Length is required.', 411)
  }
  const expectedLength = Number(header)
  if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_BODY_BYTES) {
    throw new AdminError('Request is too large.', 413)
  }

  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new AdminError('Request is too large.', 413)
    chunks.push(chunk)
  }
  if (length !== expectedLength) throw new AdminError('Request body was incomplete.')

  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AdminError('Request must contain valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('Request must contain a JSON object.')
  }
  return value
}

function routeOperation(backend, segments, body) {
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'users') {
    return () => backend.addUser(body.account)
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'users') {
    const [account, action] = segments.slice(2)
    const actions = {
      password: () => backend.resetPassword(account),
      deactivate: () => backend.deactivateUser(account),
      reactivate: () => backend.reactivateUser(account),
      delete: () => backend.deleteUser(account),
    }
    return actions[action] ?? null
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'channels') {
    return () => backend.createChannel(body.name, body.topic, body.founder)
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'channels') {
    const [channel, action] = segments.slice(2)
    const actions = {
      topic: () => backend.setTopic(channel, body.topic),
      transfer: () => backend.transferChannel(channel, body.founder),
      retire: () => backend.retireChannel(channel),
      allow: () => backend.allowChannel(channel),
    }
    return actions[action] ?? null
  }
  return null
}

function decodedSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    throw new AdminError('Request path is malformed.')
  }
}

export function createAdminServer({ tokenDigest, backend, page }) {
  let operationTail = Promise.resolve()
  const serial = operation => {
    const pending = operationTail.then(operation, operation)
    operationTail = pending.catch(() => {})
    return pending
  }

  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname

    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '')) {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Length': String(page.length),
        'Content-Type': 'text/html; charset=utf-8',
      })
      response.end(page)
      return
    }

    if (!authorized(request, tokenDigest)) {
      requireAuthentication(response)
      return
    }

    try {
      if (request.method === 'GET' && pathname === '/api/state') {
        const result = await serial(() => backend.state())
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'POST') {
        const body = await jsonBody(request)
        const operation = routeOperation(backend, decodedSegments(pathname), body)
        if (!operation) {
          sendError(response, 404, 'Unknown administration operation.')
          return
        }
        const result = await serial(operation)
        sendJson(response, 200, { ok: true, result })
        return
      }
      sendError(response, 404, 'Not found.')
    } catch (error) {
      if (error instanceof AdminError) {
        sendError(response, error.status, error.message)
        return
      }
      if (error?.code || error instanceof IrcTimeoutError) {
        sendError(response, 502, 'The chat server did not complete the administration operation.')
        return
      }
      console.error('Unexpected chat administration error:', error)
      sendError(response, 500, 'The administration service could not complete the operation.')
    }
  })
}

export async function loadTokenDigest(path) {
  const raw = (await readFile(path, 'utf8')).trim().toLowerCase()
  if (!TOKEN_HASH.test(raw)) {
    throw new Error('admin token hash file must contain one SHA-256 hex digest')
  }
  return Buffer.from(raw, 'hex')
}

export function parseArgs(argv) {
  const options = {
    listen: '127.0.0.1',
    port: 8070,
    ircAccount: 'mimir-admin',
  }
  const names = {
    '--listen': 'listen',
    '--port': 'port',
    '--token-hash-file': 'tokenHashFile',
    '--irc-account': 'ircAccount',
    '--irc-password-file': 'ircPasswordFile',
    '--page': 'page',
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]]
    const value = argv[index + 1]
    if (!name || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${argv[index] ?? ''}`)
    }
    options[name] = name === 'port' ? Number(value) : value
  }
  if (!options.tokenHashFile || !options.ircPasswordFile || !options.page) {
    throw new Error('--token-hash-file, --irc-password-file, and --page are required')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535')
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const password = (await readFile(options.ircPasswordFile, 'utf8')).trim()
  if (!password) throw new Error('administration IRC password file is empty')
  const page = await readFile(options.page)
  const server = createAdminServer({
    tokenDigest: await loadTokenDigest(options.tokenHashFile),
    backend: new ErgoAdmin(options.ircAccount, password),
    page,
  })

  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.listen, resolve)
  })
  console.log(`Mimir Chat administration listening on ${options.listen}:${options.port}`)

  const stop = () => {
    server.close(error => {
      if (error) {
        console.error(error)
        process.exitCode = 1
      }
    })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return server
}

export function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
