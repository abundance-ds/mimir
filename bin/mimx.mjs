#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_URL = process.env.MIMX_MCP_URL || 'http://127.0.0.1:17532/mcp'

const commands = {
  state: {
    tool: 'editor.state',
    args: parts => ({ include_content: parts.includes('--content') }),
  },
  open: { tool: 'editor_open', args: ([path]) => ({ path }) },
  active: { tool: 'editor_active', args: () => ({}) },
  tabs: { tool: 'editor_tabs', args: () => ({}) },
  content: { tool: 'editor_content', args: () => ({}) },
  selection: { tool: 'editor_selection', args: () => ({}) },
  comments: { tool: 'editor_comments', args: () => ({}) },
  'comments-prompt': { tool: 'editor_comments', args: () => ({}), output: 'prompt' },
  'replace-selection': { tool: 'editor_replace_selection', args: async (parts) => ({ text: await readText(parts) }) },
  'set-content': { tool: 'editor_set_content', args: async (parts) => ({ content: await readText(parts) }) },
  reveal: { tool: 'editor_reveal', args: ([target]) => parseRevealTarget(target) },
  save: { tool: 'editor_save', args: () => ({}) },
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(helpText(command === 'help' ? args[0] : ''))
    return
  }

  if (command === 'tools') {
    const json = args.includes('--json')
    const topic = args.find(arg => !arg.startsWith('-')) || ''
    const includeAll = args.includes('--all') || Boolean(topic)
    const result = await request('tools/list', { includeAll })
    console.log(formatToolCatalog(result?.tools || [], { json, topic }))
    return
  }
  if (command === 'call') {
    const [name, ...inputParts] = args
    if (!name) throw new Error('Usage: mimx call <tool> [json | --stdin]')
    const input = await readJson(inputParts)
    printResult(await callTool(name, input))
    return
  }
  if (['graph', 'board', 'context'].includes(command)) {
    console.log(await terminalGraphCommand(command, args))
    return
  }

  const spec = commands[command]
  if (!spec) {
    console.error(`Unknown command: ${command}`)
    console.error(helpText())
    process.exit(2)
  }

  const input = await spec.args(args)
  const result = await callTool(spec.tool, input)
  if (spec.output === 'prompt') {
    console.log(result?.prompt || '')
    return
  }
  printResult(result)
}

export async function callTool(name, args) {
  const body = await request('tools/call', { name, arguments: args })
  const text = body?.content?.[0]?.text ?? ''
  if (body?.isError) {
    const error = new Error(body?.structuredContent?.message || text || 'Tool call failed.')
    error.code = body?.structuredContent?.error
    error.data = body?.structuredContent?.data
    throw error
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'structuredContent')) {
    return body.structuredContent
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function terminalGraphCommand(command, args = [], call = callTool) {
  if (command === 'context') {
    const id = String(args[0] || '').trim()
    if (!id) throw new Error('Usage: mimx context <graph-node-id>')
    const context = await call('graph.context', { focusId: id, maxNodes: 16 })
    return context?.markdown || 'No graph context returned.'
  }
  if (command === 'board') {
    const status = String(args[0] || '').trim()
    const result = await call('graph.query', {
      kinds: ['issue'],
      ...(status ? { status } : {}),
      limit: 500,
    })
    return formatBoard(result?.items || [])
  }
  if (command === 'graph') {
    const query = args.join(' ').trim()
    const result = query
      ? await call('graph.search', { query, limit: 100 })
      : await call('graph.list', { limit: 100 })
    const items = query
      ? (result || []).map(item => item.node || item)
      : result?.items || []
    return formatGraph(items, query ? items.length : result?.total)
  }
  throw new Error(`Unknown graph projection: ${command}`)
}

export function formatGraph(items, total = items.length) {
  const rows = items.map(item => [
    String(item.kind || 'node').toUpperCase().padEnd(18),
    truncateCell(item.title || item.id, 48).padEnd(48),
    scopeCell(item.scopeId),
    item.id,
  ].join('  '))
  return [
    `BUSINESS GRAPH · ${items.length}${Number.isFinite(total) ? ` of ${total}` : ''}`,
    'KIND                TITLE                                             SCOPE    ID',
    ...rows,
  ].join('\n')
}

export function formatBoard(items) {
  const statuses = ['backlog', 'plan', 'in-progress', 'waiting', 'review', 'done', 'cancelled']
  const sections = []
  for (const status of statuses) {
    const issues = items.filter(item => (item.status || 'backlog') === status)
    if (!issues.length) continue
    sections.push(`\n${status.replaceAll('-', ' ').toUpperCase()} · ${issues.length}`)
    for (const issue of issues) {
      const marker = { urgent: '!!', high: ' !', normal: ' ·', low: '  ' }[issue.priority] || ' ·'
      const project = issue.projectId ? `  → ${issue.projectId}` : ''
      sections.push(`${marker} ${truncateCell(issue.title || issue.id, 64)}  [${issue.id}]${project}`)
    }
  }
  return `WORK BOARD · ${items.length}${sections.join('\n') || '\n\nNo issues in this projection.'}`
}

async function request(method, params) {
  let response
  try {
    response = await fetch(DEFAULT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    })
  } catch {
    throw new Error(`mimx could not reach ${DEFAULT_URL} — start the Mim workbench or set MIMX_MCP_URL`)
  }

  if (!response.ok) {
    throw new Error(`mimx server returned HTTP ${response.status}`)
  }

  const body = await response.json()
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error))

  return body.result
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
    const fs = await import('node:fs/promises')
    return await fs.readFile(parts[1], 'utf8')
  }
  return parts.join(' ')
}

async function readJson(parts) {
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
  if (result === undefined || result === null || result === '') return
  if (typeof result === 'string') console.log(result)
  else console.log(JSON.stringify(result, null, 2))
}

function parseRevealTarget(target = '') {
  if (!target) return {}
  const match = target.match(/^(.*?):(\d+)$/)
  if (match) return { path: match[1] || undefined, line: Number(match[2]) }
  if (/^\d+$/.test(target)) return { line: Number(target) }
  return { path: target }
}

export function helpText(topic = '') {
  const normalized = String(topic || '').trim().toLowerCase()
  if (normalized && HELP_TOPICS[normalized]) return HELP_TOPICS[normalized]
  if (normalized) {
    return `Unknown help topic: ${topic}\n\n${helpText()}`
  }
  return `mimx — optional access to the attached Mim workbench

Use normal file and shell tools for ordinary coding.

  mimx state [--content]          active editor context
  mimx reveal <path:line>         show a location in Mim
  mimx tools [topic]              discover optional capabilities
  mimx call <tool> [json|--stdin] call one capability
  mimx help <topic>               focused help

Topics: core, editor, review, comments, graph, files, activities, apps,
        routines, settings, web, docs

MIMX_MCP_URL defaults to ${DEFAULT_URL}`
}

const HELP_TOPICS = Object.freeze({
  core: `Core agent tools

  mim_state    Get active editor state.
  mim_reveal   Open a file in Mim, optionally at a line.
  mim_propose  Propose one exact text replacement for review.

Use: mimx call <tool> '<json>'`,
  editor: `Editor shortcuts

  mimx state [--content]
  mimx open <path>
  mimx reveal <path:line|line|path>
  mimx active | tabs | content | selection
  mimx replace-selection <text|--stdin|--file path>
  mimx set-content <--stdin|--file path>
  mimx save`,
  review: `Reviewable changes

  mimx call mim_propose '{"path":"/workspace/README.md","old_text":"before","new_text":"after","rationale":"Why"}'

The path is optional. Mim opens the target and shows the exact replacement as
a diff for acceptance or rejection; it does not apply the proposal directly.`,
  comments: `Comments

  mimx comments
  mimx comments-prompt
  mimx tools comments`,
  graph: `Business graph

  mimx graph [search terms]
  mimx board [status]
  mimx context <graph-node-id>
  mimx tools graph`,
  files: 'Optional file capabilities: mimx tools files',
  activities: 'Activity capabilities: mimx tools activities',
  apps: 'App capabilities: mimx tools apps',
  routines: 'Routine capabilities: mimx tools routines',
  settings: 'Settings capabilities: mimx tools settings',
  web: 'Academic metadata search: mimx tools web',
  docs: `Mim keeps dense implementation notes and old tutorials out of agent context.

In the source tree, browse docs/reference/ only when a focused help topic is
insufficient.`,
  tools: `Tool discovery

  mimx tools              three default agent tools
  mimx tools <topic>      names and descriptions for one domain
  mimx tools --all        every registered capability, without schemas
  mimx tools --json       default schemas
  mimx tools --all --json full raw registry`,
})

export function formatToolCatalog(tools, { json = false, topic = '' } = {}) {
  const filtered = filterToolsByTopic(tools, topic)
  if (json) return JSON.stringify(filtered, null, 2)
  if (!filtered.length) return topic
    ? `No tools found for topic '${topic}'.`
    : 'No Mim tools are currently available.'
  return filtered
    .map(tool => `${tool.name}\t${tool.description || ''}`.trimEnd())
    .join('\n')
}

function filterToolsByTopic(tools, topic) {
  const normalized = String(topic || '').trim().toLowerCase()
  if (!normalized) return tools
  const domains = TOOL_TOPIC_DOMAINS[normalized] || [normalized]
  return tools.filter((tool) => {
    const canonical = String(tool?._meta?.['mim/canonicalName'] || tool?.name || '')
    return domains.some(domain => canonical === domain || canonical.startsWith(`${domain}.`))
  })
}

const TOOL_TOPIC_DOMAINS = Object.freeze({
  core: ['editor.state', 'editor.reveal', 'editor.propose'],
  review: ['editor.propose', 'files.edit'],
  comments: ['comments', 'editor.comments'],
  graph: ['graph', 'knowledge', 'issues', 'projects', 'research'],
  business: ['graph', 'knowledge', 'issues', 'projects', 'research'],
})

function scopeCell(scopeId = '') {
  return String(scopeId).split(':')[0].slice(0, 7).padEnd(7)
}

function truncateCell(value, limit) {
  const text = String(value || '').replaceAll(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exit(1)
  })
}
