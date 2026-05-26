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
  if (result !== undefined && result !== null && result !== '') {
    if (typeof result === 'string') console.log(result)
    else console.log(JSON.stringify(result, null, 2))
  }
}

async function callTool(name, args) {
  const response = await fetch(DEFAULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })

  if (!response.ok) {
    throw new Error(`mimx server returned HTTP ${response.status}`)
  }

  const body = await response.json()
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error))

  const text = body.result?.content?.[0]?.text ?? ''
  if (body.result?.isError) throw new Error(text)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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

function parseRevealTarget(target = '') {
  if (!target) return {}
  const match = target.match(/^(.*?):(\d+)$/)
  if (match) return { path: match[1] || undefined, line: Number(match[2]) }
  if (/^\d+$/.test(target)) return { line: Number(target) }
  return { path: target }
}

function printHelp() {
  console.log(`mimx - control the attached Mim Panel editor

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

Environment:
  MIMX_MCP_URL  defaults to ${DEFAULT_URL}`)
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exit(1)
})
