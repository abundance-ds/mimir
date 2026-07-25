#!/usr/bin/env node

const DEFAULT_URL = process.env.MIMX_MCP_URL || 'http://127.0.0.1:17532/mcp'

const commands = {
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
    printHelp()
    return
  }

  if (command === 'tools') {
    const tools = await request('tools/list', {})
    console.log(JSON.stringify(tools?.tools || [], null, 2))
    return
  }
  if (command === 'call') {
    const [name, ...inputParts] = args
    if (!name) throw new Error('Usage: mimx call <tool> [json | --stdin]')
    const input = await readJson(inputParts)
    printResult(await callTool(name, input))
    return
  }

  const spec = commands[command]
  if (!spec) {
    console.error(`Unknown command: ${command}`)
    printHelp()
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

async function callTool(name, args) {
  const body = await request('tools/call', { name, arguments: args })
  const text = body?.content?.[0]?.text ?? ''
  if (body?.isError) throw new Error(text)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function request(method, params) {
  const response = await fetch(DEFAULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  })

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

function printHelp() {
  console.log(`mimx - control the attached Mim editor

Usage:
  mimx open <path>
  mimx active
  mimx tabs
  mimx content
  mimx selection
  mimx comments
  mimx comments-prompt
  mimx replace-selection <text>
  mimx replace-selection --stdin
  mimx replace-selection --file <path>
  mimx set-content --stdin
  mimx reveal <path:line|line|path>
  mimx save
  mimx tools
  mimx call <tool> '{"key":"value"}'
  mimx call <tool> --stdin

Environment:
  MIMX_MCP_URL  defaults to ${DEFAULT_URL}`)
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exit(1)
})
