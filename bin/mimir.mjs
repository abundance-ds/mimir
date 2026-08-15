#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  addSkill,
  findSkill,
  formatSkill,
  formatSkillMatches,
  listSkills,
  prepareSkills,
  refreshNativeSkills,
} from './mimir-skills.mjs'

const FALLBACK_URL = 'http://127.0.0.1:17532/mcp'
const REQUEST_TIMEOUT_MS = 10_000
const TOOL_GROUPS = Object.freeze(['workbench', 'graph', 'meetings', 'chat', 'connections'])

export async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(helpText(command === 'help' ? args[0] : ''))
    return
  }

  if (command === 'tool') {
    if (wantsHelp(args) || !positional(args).length) {
      console.log(toolCommandHelp())
      return
    }
    assertKnownFlags(args, ['--json'])
    const query = positional(args).join(' ')
    const result = await findTools(query)
    console.log(args.includes('--json')
      ? JSON.stringify(result.tool || result.matches || [], null, 2)
      : result.tool
        ? formatToolHelp(result.tool)
        : result.matches?.length
          ? formatToolCatalog(result.matches)
          : `No Mimir tool matches '${query}'.`)
    return
  }
  if (command === 'tools') {
    if (wantsHelp(args)) {
      console.log(HELP_TOPICS.tools)
      return
    }
    assertKnownFlags(args, ['--json'])
    const extra = positional(args)
    if (extra.length > 1) throw new Error('Usage: mimir tools [group] [--json]')
    const group = String(extra[0] || '').toLowerCase()
    if (group && !TOOL_GROUPS.includes(group)) {
      throw new Error(`Unknown tool group '${extra[0]}'. Use ${TOOL_GROUPS.join(', ')}.`)
    }
    const json = args.includes('--json')
    const result = await request('tools/list', { includeAll: true })
    const tools = result?.tools || []
    const selected = group
      ? tools.filter(tool => tool?._meta?.['mimir/group'] === group)
      : tools
    console.log(json
      ? JSON.stringify(selected, null, 2)
      : group
        ? formatToolGroup(selected, group)
        : formatPublicTools(tools))
    return
  }
  if (command === 'call') {
    const [name, ...inputParts] = args
    if (!name || name === '--help' || name === '-h') {
      console.log(callCommandHelp())
      return
    }
    if (wantsHelp(inputParts)) {
      console.log(formatToolHelp(await discoverTool(name)))
      return
    }
    assertKnownFlags(inputParts, ['--stdin', '--file'])
    const input = await readJson(inputParts)
    printResult(await callTool(name, input))
    return
  }
  if (command === 'skill') {
    await skillCommand(args)
    return
  }
  if (command === 'skills') {
    await skillsCommand(args)
    return
  }
  if (command === 'doctor') {
    if (wantsHelp(args)) {
      console.log(doctorCommandHelp())
      return
    }
    assertKnownFlags(args, ['--json', '--verbose'])
    const report = await runDoctor({ verbose: args.includes('--verbose') })
    console.log(args.includes('--json')
      ? JSON.stringify(report, null, 2)
      : formatDoctor(report))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'mcp-proxy') {
    await runMcpProxy()
    return
  }
  if (command === 'internal' && args[0] === 'codex-notify') {
    await recordCodexSessionBinding(args.slice(1))
    return
  }
  console.error(`Unknown command: ${command}`)
  console.error(helpText())
  process.exit(2)
}

export async function recordCodexSessionBinding(args, env = process.env) {
  const payloadText = args.at(-1)
  const payload = JSON.parse(String(payloadText || '{}'))
  const activityId = String(env.MIMIR_ACTIVITY_ID || '').trim()
  const runId = String(env.MIMIR_ACTIVITY_RUN_ID || '').trim()
  const cliSessionId = String(payload['thread-id'] || '').trim()
  if (!activityId) throw new Error('Codex notify is missing MIMIR_ACTIVITY_ID.')
  if (!isUuid(runId)) throw new Error('Codex notify has an invalid MIMIR_ACTIVITY_RUN_ID.')
  if (!isUuid(cliSessionId)) throw new Error('Codex notify payload has no valid thread-id.')

  const directory = String(
    env.MIMIR_SESSION_BINDINGS_DIR
      || join(homedir(), '.mimir', 'session-bindings'),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${runId}.json`)
  const temporary = join(directory, `.${runId}.${process.pid}.tmp`)
  const binding = `${JSON.stringify({ activityId, runId, cliSessionId })}\n`
  await writeFile(temporary, binding, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    const existing = await readFile(path, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (
      existing?.activityId !== activityId
      || existing?.runId !== runId
      || existing?.cliSessionId !== cliSessionId
    ) {
      await rm(temporary, { force: true })
      throw error
    }
    await rm(temporary, { force: true })
  }

  const forwardIndex = args.indexOf('--forward-json')
  if (forwardIndex >= 0 && forwardIndex + 1 < args.length - 1) {
    const command = JSON.parse(args[forwardIndex + 1])
    if (Array.isArray(command) && command.length && command.every(part => (
      typeof part === 'string' && part.length > 0
    ))) {
      const child = spawn(command[0], [...command.slice(1), payloadText], {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
    }
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)
}

async function skillCommand(args) {
  if (wantsHelp(args) || !args.length) {
    console.log(skillCommandHelp())
    return
  }
  if (args[0] === 'add') {
    const source = args[1]
    if (!source) throw new Error('Usage: mimir skill add <directory> <--catalog|--personal|--project>')
    assertKnownFlags(args.slice(2), ['--catalog', '--personal', '--project'])
    const scopes = ['catalog', 'personal', 'project'].filter(scope => args.includes(`--${scope}`))
    if (scopes.length !== 1) {
      throw new Error('Choose one skill scope: --catalog, --personal, or --project.')
    }
    const added = await addSkill(source, scopes[0])
    console.log(`${added.name} [${added.scope}]\nPath: ${added.path}`)
    return
  }
  assertKnownFlags(args, ['--json'])
  const query = positional(args).join(' ')
  if (!query) throw new Error('Usage: mimir skill <query>')
  const result = await findSkill(query)
  if (args.includes('--json')) {
    console.log(JSON.stringify(result.skill || result.matches || [], null, 2))
    return
  }
  console.log(result.skill
    ? formatSkill(result.skill)
    : formatSkillMatches(result.matches || []))
}

export async function skillsCommand(args) {
  if (wantsHelp(args)) {
    console.log(skillsCommandHelp())
    return
  }
  if (args[0] === 'refresh') {
    assertKnownFlags(args.slice(1), [])
    const result = await refreshNativeSkills()
    console.log(`Skills ready: ${result.count}\nPath: ${result.root}`)
    return
  }
  if (args[0] === 'prepare') {
    const client = args[1]
    assertKnownFlags(args.slice(2), ['--json'])
    if (!client) throw new Error('Missing skill client.')
    const result = await prepareSkills(client)
    console.log(JSON.stringify(result))
    return
  }
  const listArgs = args[0] === 'list' ? args.slice(1) : args
  assertKnownFlags(listArgs, ['--json'])
  if (positional(listArgs).length) {
    throw new Error('Usage: mimir skills [list] [--json]')
  }
  const skills = await listSkills()
  console.log(listArgs.includes('--json')
    ? JSON.stringify(skills, null, 2)
    : formatSkillMatches(skills, { limit: Number.POSITIVE_INFINITY }))
}

export async function findTools(query, tools) {
  const catalog = tools || (await request('tools/list', { includeAll: true }))?.tools || []
  const normalized = normalizeToolQuery(query)
  const exact = catalog.find(tool => toolIdentifiers(tool).some(identifier => (
    normalizeToolQuery(identifier) === normalized
  )))
  if (exact) return { tool: exact }

  const terms = normalized.split(/[._\s-]+/).filter(Boolean)
  const ranked = catalog
    .map(tool => ({ tool, score: scoreTool(tool, normalized, terms) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.tool.name.localeCompare(right.tool.name))
  if (ranked.length === 1 || (
    ranked.length > 1 && ranked[0].score >= ranked[1].score + 40
  )) {
    return { tool: ranked[0].tool }
  }
  return { matches: ranked.slice(0, 5).map(entry => entry.tool) }
}

export async function discoverTool(query, tools) {
  const result = await findTools(query, tools)
  if (result.tool) return result.tool
  if (!result.matches?.length) throw new Error(`No Mimir tool matches '${query}'.`)
  const choices = result.matches
    .map(tool => `${tool.name}\t${tool.description || ''}`)
    .join('\n')
  throw new Error(`Multiple Mimir tools match '${query}':\n${choices}`)
}

export function formatToolHelp(tool) {
  const schema = tool?.inputSchema || {}
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const requiredRows = []
  const optionalRows = []
  for (const [name, property] of Object.entries(properties)) {
    const row = formatSchemaProperty(name, property, '  ')
    ;(required.has(name) ? requiredRows : optionalRows).push(row)
  }

  const sections = [
    `${tool.name} — ${tool.description || 'Mimir capability'}`,
  ]
  if (requiredRows.length) sections.push(`Required:\n${requiredRows.join('\n')}`)
  if (optionalRows.length) sections.push(`Optional:\n${optionalRows.join('\n')}`)
  const annotations = formatAnnotations(tool.annotations)
  if (annotations) sections.push(annotations)
  const skeleton = Object.fromEntries(
    [...required].map(name => [name, schemaPlaceholder(properties[name])]),
  )
  sections.push(`mimir call ${tool.name} '${JSON.stringify(skeleton)}'`)
  return sections.join('\n\n')
}

function formatSchemaProperty(name, property = {}, indent = '', nestedRequired = false) {
  const type = renderSchemaType(property)
  const suffix = [
    nestedRequired ? 'required' : '',
    property.default !== undefined ? `default ${JSON.stringify(property.default)}` : '',
    Array.isArray(property.enum) ? `one of ${property.enum.map(value => JSON.stringify(value)).join(', ')}` : '',
    property.const !== undefined ? `must equal ${JSON.stringify(property.const)}` : '',
    Number.isInteger(property.minLength) ? `min ${property.minLength} chars` : '',
    Number.isInteger(property.maxLength) ? `max ${property.maxLength} chars` : '',
    Number.isInteger(property.minItems) ? `min ${property.minItems} items` : '',
    Number.isInteger(property.maxItems) ? `max ${property.maxItems} items` : '',
    Number.isFinite(property.minimum) ? `>= ${property.minimum}` : '',
    Number.isFinite(property.maximum) ? `<= ${property.maximum}` : '',
    Number.isFinite(property.exclusiveMinimum) ? `> ${property.exclusiveMinimum}` : '',
    Number.isFinite(property.exclusiveMaximum) ? `< ${property.exclusiveMaximum}` : '',
    typeof property.pattern === 'string' ? `pattern ${JSON.stringify(property.pattern)}` : '',
  ].filter(Boolean).join('; ')
  const first = `${indent}${name}: ${type}${suffix ? ` (${suffix})` : ''}`
  const description = String(property.description || '').trim()
  const lines = [first]
  if (description) lines.push(`${indent}  ${description}`)
  lines.push(...nestedSchemaLines(property, `${indent}  `))
  return lines.join('\n')
}

function renderSchemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (schema.type === 'array') {
    return `array<${renderSchemaType(schema.items || {})}>`
  }
  if (schema.type) return schema.type
  if (schema.properties) return 'object'
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return [...new Set(schema.enum.map(value => typeof value))].join(' | ')
  }
  const variants = schema.oneOf || schema.anyOf
  if (Array.isArray(variants) && variants.length) {
    return [...new Set(variants.map(renderSchemaType))].join(' | ')
  }
  return 'value'
}

function schemaPlaceholder(schema = {}) {
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type
  if (type === 'boolean') return false
  if (type === 'number' || type === 'integer') {
    if (Number.isFinite(schema.minimum)) return schema.minimum
    if (Number.isFinite(schema.exclusiveMinimum)) {
      return schema.exclusiveMinimum + (type === 'integer' ? 1 : 0.1)
    }
    if (Number.isFinite(schema.maximum) && schema.maximum < 0) return schema.maximum
    return 0
  }
  if (type === 'array') {
    const count = Math.max(0, Number(schema.minItems) || 0)
    return Array.from({ length: count }, () => schemaPlaceholder(schema.items || {}))
  }
  if (type === 'object' || schema.properties) {
    const properties = schema.properties || {}
    return Object.fromEntries(
      (schema.required || []).map(name => [name, schemaPlaceholder(properties[name] || {})]),
    )
  }
  if (type === 'string') {
    const minimum = Math.max(0, Number(schema.minLength) || 0)
    const maximum = Number.isInteger(schema.maxLength)
      ? schema.maxLength
      : Number.POSITIVE_INFINITY
    return '.'.repeat(Math.min(maximum, Math.max(minimum, 3)))
  }
  return '...'
}

function nestedSchemaLines(schema, indent) {
  const lines = []
  const objectSchema = schema.type === 'array' ? schema.items : schema
  if (
    !objectSchema
    || typeof objectSchema !== 'object'
    || !objectSchema.properties
    || typeof objectSchema.properties !== 'object'
  ) {
    return lines
  }
  if (schema.type === 'array') lines.push(`${indent}Items:`)
  const required = new Set(objectSchema.required || [])
  const childIndent = schema.type === 'array' ? `${indent}  ` : indent
  for (const [name, property] of Object.entries(objectSchema.properties)) {
    lines.push(formatSchemaProperty(name, property, childIndent, required.has(name)))
  }
  return lines
}

function formatAnnotations(annotations = {}) {
  const labels = []
  if (annotations.readOnlyHint === true) labels.push('read-only')
  else if (annotations.readOnlyHint === false) labels.push('mutating')
  if (annotations.destructiveHint === true) labels.push('destructive')
  if (annotations.idempotentHint === true) labels.push('idempotent')
  return labels.length ? `Behavior: ${labels.join(', ')}` : ''
}

function toolIdentifiers(tool) {
  return [tool?.name].filter(Boolean)
}

function normalizeToolQuery(value) {
  return String(value || '').trim().toLowerCase().replaceAll(' ', '_')
}

function scoreTool(tool, query, terms) {
  const identifiers = toolIdentifiers(tool).map(normalizeToolQuery)
  const description = String(tool?.description || '').toLowerCase()
  let score = identifiers.some(identifier => identifier.includes(query)) ? 80 : 0
  for (const term of terms) {
    for (const identifier of identifiers) {
      if (identifier === term) score += 50
      else if (identifier.startsWith(term)) score += 30
      else if (identifier.includes(term)) score += 20
    }
    if (description.includes(term)) score += 6
  }
  return score
}

export async function callTool(name, args, options = {}) {
  const body = await request('tools/call', { name, arguments: args }, options)
  if (!body || typeof body !== 'object') {
    throw new Error(`mimir server returned no result for '${name}'. Run \`mimir doctor\`.`)
  }
  const text = body.content?.[0]?.text ?? ''
  if (body.isError) {
    const error = new Error(body.structuredContent?.message || text || 'Tool call failed.')
    error.code = body.structuredContent?.error
    error.data = body.structuredContent?.data
    throw error
  }
  if (Object.prototype.hasOwnProperty.call(body, 'structuredContent')) {
    return body.structuredContent
  }
  if (!text) {
    throw new Error(`mimir server returned an empty result for '${name}'. Run \`mimir doctor\`.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function request(method, params, options = {}) {
  if (
    !options.protocolVersion
    && method !== 'initialize'
    && method !== 'notifications/initialized'
  ) {
    const initialized = await rpcRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mimir-cli', version: '0.1.0' },
    }, { ...options, notification: false })
    const protocolVersion = initialized?.protocolVersion
    await rpcRequest('notifications/initialized', {}, {
      ...options,
      protocolVersion,
      notification: true,
    })
    return await rpcRequest(method, params, {
      ...options,
      protocolVersion,
      notification: false,
    })
  }
  return await rpcRequest(method, params, { ...options, notification: false })
}

async function notify(method, params, options = {}) {
  await rpcRequest(method, params, { ...options, notification: true })
}

async function rpcRequest(method, params, options) {
  const endpoint = options.endpoint || mcpEndpoint()
  const safeEndpoint = displayEndpoint(endpoint, options.verbose)
  const id = options.notification ? undefined : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const timeout = Number.isFinite(options.timeout) ? options.timeout : REQUEST_TIMEOUT_MS
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(options.protocolVersion
          ? { 'mcp-protocol-version': options.protocolVersion }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(id === undefined ? {} : { id }),
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    const detail = networkErrorDetail(error, timeout)
    const remedy = options.doctor
      ? 'Open or restart Mimir, then retry.'
      : 'Run `mimir doctor`.'
    throw new Error(
      `mimir could not reach ${safeEndpoint}: ${detail}. ${remedy}`,
      { cause: error },
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `mimir server at ${safeEndpoint} returned HTTP ${response.status}${detail ? `: ${truncateCell(detail, 240)}` : ''}`,
    )
  }

  if (options.notification) return undefined
  const body = await response.json().catch(error => {
    throw new Error(`mimir server at ${safeEndpoint} returned invalid JSON: ${error.message}`)
  })
  if (body.error) {
    const message = body.error.message === 'Unknown tool' && body.error.data?.name
      ? `Unknown tool '${body.error.data.name}'.`
      : body.error.message || JSON.stringify(body.error)
    const error = new Error(message)
    error.code = body.error.code
    error.data = body.error.data
    throw error
  }

  return body.result
}

export async function runMcpProxy({
  input = process.stdin,
  output = process.stdout,
  endpoint = mcpEndpoint(),
  fetchImpl = fetch,
} = {}) {
  const { createInterface } = await import('node:readline')
  let protocolVersion
  let initialization = Promise.resolve()
  const pending = new Set()
  const lines = createInterface({ input, crlfDelay: Infinity })
  async function forward(message) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${truncateCell(await response.text(), 240)}`)
      }
      if (message.id === undefined) return
      const payload = await parseMcpResponse(response)
      if (message.method === 'initialize') {
        protocolVersion = payload?.result?.protocolVersion || protocolVersion
      }
      output.write(`${JSON.stringify(payload)}\n`)
    } catch (error) {
      if (message.id === undefined) {
        console.error(`mimir MCP proxy: ${networkErrorDetail(error, 120_000)}`)
        return
      }
      output.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Mimir unavailable: ${networkErrorDetail(error, 120_000)}`,
        },
      })}\n`)
    }
  }

  for await (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      output.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      })}\n`)
      continue
    }

    const prerequisite = message.method === 'initialize'
      ? Promise.resolve()
      : initialization
    const task = prerequisite.then(() => forward(message))
    if (message.method === 'initialize') initialization = task
    pending.add(task)
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    )
  }
  await Promise.all([...pending])
}

async function parseMcpResponse(response) {
  const contentType = response.headers?.get?.('content-type') || ''
  if (!contentType.includes('text/event-stream')) return await response.json()
  const text = await response.text()
  const data = text
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
    .at(-1)
  if (!data) throw new Error('Mimir returned an empty event stream.')
  return JSON.parse(data)
}

export async function runDoctor({ verbose = false } = {}) {
  const endpoint = mcpEndpoint()
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mimir-cli', version: '0.1.0' },
  }, { endpoint, verbose, doctor: true })
  const protocolVersion = initialized?.protocolVersion
  await notify('notifications/initialized', {}, {
    endpoint,
    verbose,
    protocolVersion,
    doctor: true,
  })
  await request('ping', {}, { endpoint, verbose, protocolVersion, doctor: true })
  const diagnostics = await request('mimir/doctor', {}, {
    endpoint,
    verbose,
    protocolVersion,
    doctor: true,
  })
  const scopes = Array.isArray(diagnostics?.scopes)
    ? [...new Set(diagnostics.scopes
        .map(scope => scope.id || scope.scopeId)
        .filter(Boolean)
        .map(scope => verbose ? scope : String(scope).split(':')[0]))]
    : []
  const connectionDiagnostics = diagnostics?.connectionDiagnostics || {}
  const connectionErrors = Object.values(connectionDiagnostics)
    .filter(value => value && typeof value === 'object' && value.status === 'error')
  return {
    ok: diagnostics?.graphOk !== false && connectionErrors.length === 0,
    verbose,
    endpoint: displayEndpoint(endpoint, verbose),
    protocolVersion,
    server: initialized?.serverInfo || {},
    context: activityContext(endpoint),
    scopes,
    tools: diagnostics?.tools || 0,
    registryRevision: diagnostics?.registryRevision,
    connections: diagnostics?.connections || {},
    connectionDiagnostics,
    ...(diagnostics?.graphError ? { graphError: diagnostics.graphError } : {}),
  }
}

export function formatDoctor(report) {
  const connectionTools = Object.entries(report.connections || {})
    .filter(([, available]) => available)
    .map(([name]) => name)
  const connectionErrors = Object.entries(report.connectionDiagnostics || {})
    .filter(([, value]) => (
      value
      && typeof value === 'object'
      && value.status === 'error'
    ))
    .map(([name, value]) => `${name}: ${value.detail}`)
  const lines = [
    report.ok ? 'Mimir OK' : 'Mimir degraded',
    `Endpoint   reachable${report.verbose ? ` (${report.endpoint})` : ''}`,
    `Context    ${report.context}`,
    `Scopes     ${report.scopes.length ? report.scopes.join(', ') : 'unavailable'}`,
    `Connection tools ${connectionTools.length ? connectionTools.join(', ') : 'none'}`,
    `Tools      ${report.tools}`,
  ]
  if (report.graphError) lines.push(`Graph      ${report.graphError}`)
  if (connectionErrors.length) lines.push(`Connection errors ${connectionErrors.join('; ')}`)
  return lines.join('\n')
}

function mcpEndpoint() {
  return process.env.MIMIR_MCP_URL || FALLBACK_URL
}

function displayEndpoint(value, verbose = false) {
  if (verbose) return String(value)
  try {
    const url = new URL(String(value))
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<invalid MIMIR_MCP_URL>'
  }
}

function activityContext(value) {
  try {
    const url = new URL(String(value))
    return url.searchParams.get('activityId') ? 'attached' : 'not attached'
  } catch {
    return 'invalid endpoint'
  }
}

function networkErrorDetail(error, timeout = REQUEST_TIMEOUT_MS) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `timed out after ${timeout}ms`
  }
  const code = error?.cause?.code || error?.code
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ENOTFOUND') return 'host not found'
  if (code) return String(code)
  return error?.message || 'network request failed'
}

async function readText(parts) {
  if (parts[0] === '--stdin' || parts.length === 0) {
    return await new Promise((resolve, reject) => {
      let text = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { text += chunk })
      process.stdin.on('end', () => resolve(text))
      process.stdin.on('error', reject)
    })
  }
  if (parts[0] === '--file') {
    if (!parts[1]) throw new Error('Missing path after --file.')
    const fs = await import('node:fs/promises')
    return await fs.readFile(parts[1], 'utf8')
  }
  return parts.join(' ')
}

async function readJson(parts) {
  if (!parts.length) return {}
  const text = await readText(parts)
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('input must be a JSON object')
    }
    return value
  } catch (error) {
    throw new Error(`Invalid tool input JSON: ${error.message}`)
  }
}

function printResult(result) {
  if (typeof result === 'string') console.log(result)
  else console.log(JSON.stringify(result, null, 2))
}

function truncateCell(value, limit) {
  const text = String(value || '').replaceAll(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`
}

export function helpText(topic = '') {
  const normalized = String(topic || '').trim().toLowerCase()
  if (normalized && HELP_TOPICS[normalized]) return HELP_TOPICS[normalized]
  if (normalized) {
    return `Unknown help topic: ${topic}\n\n${helpText()}`
  }
  return `mimir — attached Mimir workbench

  mimir tools            list all available capabilities
  mimir tools <group>    list one focused drawer
  mimir tool <name>      show one capability and its inputs
  mimir skill <query>    find a workflow
  mimir doctor           diagnose the connection
  mimir call <tool> ...  call a capability`
}

const HELP_TOPICS = Object.freeze({
  core: `Core agent tools

  mimir_state    Get active editor state.
  mimir_reveal   Open a file in Mimir, optionally at a line.
  mimir_propose  Propose one exact text replacement for review.

Use: mimir call <tool> '<json>'`,
  review: `Reviewable changes

  mimir call mimir_propose '{"path":"/workspace/README.md","old_text":"before","new_text":"after","rationale":"Why"}'

The path is optional. Mimir opens the target and shows the exact replacement as
a diff for acceptance or rejection; it does not apply the proposal directly.`,
  docs: `Repository documentation

Use docs/_MAP.md to locate the owning document for a subsystem.`,
  tools: `Tool discovery

  mimir tools            concise available catalog
  mimir tools <group>    compact signatures for workbench, graph, meetings, chat, or connections
  mimir tools --json     machine-readable available catalog
  mimir tool <name>      complete inputs and ready call`,
})

function toolCommandHelp() {
  return `Usage: mimir tool <name-or-query> [--json]

Find one Mimir capability and show only the inputs needed to call it.`
}

function callCommandHelp() {
  return `Usage: mimir call <tool> [json | --stdin | --file path]
       mimir call <tool> --help`
}

function skillCommandHelp() {
  return `Usage: mimir skill <name-or-query> [--json]
       mimir skill add <directory> <--catalog|--personal|--project>`
}

function skillsCommandHelp() {
  return `Usage: mimir skills [list] [--json]
       mimir skills refresh`
}

function doctorCommandHelp() {
  return `Usage: mimir doctor [--json] [--verbose]`
}

export function formatToolCatalog(tools, { json = false, topic = '' } = {}) {
  const normalized = normalizeToolQuery(topic)
  const filtered = normalized
    ? tools.filter(tool => normalizeToolQuery(tool?.name).includes(normalized))
    : tools
  if (json) return JSON.stringify(filtered, null, 2)
  if (!filtered.length) return topic
    ? `No tools found for topic '${topic}'.`
    : 'No Mimir tools are currently available.'
  return filtered
    .map(tool => `${tool.name}\t${tool.description || ''}`.trimEnd())
    .join('\n')
}

export function formatPublicTools(tools) {
  if (!tools.length) return 'No Mimir tools are currently available.'
  const groups = new Map()
  for (const tool of tools) {
    const group = tool?._meta?.['mimir/group'] || 'other'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(tool)
  }
  const sections = [...groups]
    .sort(([left], [right]) => {
      const leftIndex = TOOL_GROUPS.indexOf(left)
      const rightIndex = TOOL_GROUPS.indexOf(right)
      return (leftIndex < 0 ? TOOL_GROUPS.length : leftIndex)
        - (rightIndex < 0 ? TOOL_GROUPS.length : rightIndex)
        || left.localeCompare(right)
    })
    .map(([group, entries]) => {
      const rows = entries.map((tool) => {
        const effect = tool?._meta?.['mimir/effect'] || annotationEffect(tool.annotations)
        return `${String(tool.name).padEnd(24)} [${effect}]  ${tool.description || ''}`.trimEnd()
      })
      const drawer = TOOL_GROUPS.includes(group) ? `  (mimir tools ${group})` : ''
      return `${group.toUpperCase()}${drawer}\n\n${rows.join('\n')}`
    })
  return sections.join('\n\n')
}

const TOOL_GROUP_NOTES = Object.freeze({
  workbench: 'mimir_propose opens a review; it does not change the file. files_trash is the only sanctioned deletion — never rm workspace files; other file operations use your shell and Mimir follows along.',
  graph: 'Omitting scopeIds searches every mounted scope, including private. Use graph_get.sourceRevision as graph_update/graph_delete expectedRevision; graph_delete returns graph_restore.undoToken.',
  meetings: 'Meeting tools expose stopped records only. Recording controls remain human-only; meetings_delete is permanent and requires an explicit user request.',
  chat: 'target defaults to the linked or open room.',
  connections: 'Only configured tools appear. external-write sends or creates remote data.',
})

export function formatToolGroup(tools, group) {
  const normalized = String(group || '').toLowerCase()
  const header = normalized.toUpperCase()
  if (!tools.length) {
    const remedy = normalized === 'connections'
      ? ' Open Mimir Settings → Connections to connect Google, Slack, or Granola.'
      : ''
    return `${header}\n\nNo ${normalized} tools are currently available.${remedy}`
  }
  const rows = tools.map((tool) => {
    const schema = tool?.inputSchema || {}
    const properties = Object.keys(schema.properties || {})
    const required = Array.isArray(schema.required) ? schema.required : []
    const requiredSet = new Set(required)
    const optional = properties.filter(name => !requiredSet.has(name))
    const signature = [
      tool.name,
      required.length ? required.join(', ') : '',
      optional.length ? `[${optional.join(', ')}]` : '',
    ].filter(Boolean).join(' ')
    const effect = tool?._meta?.['mimir/effect'] || annotationEffect(tool.annotations)
    return `${signature}  [${effect}] ${tool.description || ''}`.trimEnd()
  })
  const note = TOOL_GROUP_NOTES[normalized]
  return `${header}\n\n${rows.join('\n')}${note ? `\n\n${note}` : ''}`
}

function annotationEffect(annotations = {}) {
  if (annotations.destructiveHint === true) return 'destructive'
  return annotations.readOnlyHint === true ? 'read' : 'write'
}

function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h')
}

function positional(args) {
  return args.filter(arg => !arg.startsWith('-'))
}

function assertKnownFlags(args, allowed) {
  const unknown = args.find(arg => arg.startsWith('-') && !allowed.includes(arg))
  if (unknown) throw new Error(`Unknown option: ${unknown}`)
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
