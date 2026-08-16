import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const PACKAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PACKAGE_PROMPT_LIMIT = 512 * 1024

export function parsePackageFrontmatter(content, { label = 'package', required = false } = {}) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    if (required) throw new Error(`${label} must start with YAML frontmatter`)
    return { frontmatter: {}, body: normalized }
  }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${label} frontmatter is not closed`)
  return {
    frontmatter: parseTopLevelYaml(normalized.slice(4, end), label),
    body: normalized.slice(end + 5),
  }
}

export function humanizePackageName(value) {
  return String(value || '')
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function uniquePhysicalRoots(entries) {
  const seen = new Set()
  return entries.filter((entry) => {
    if (!entry.root) return false
    const identity = path.resolve(entry.root)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export async function pathExists(value) {
  try {
    await fs.lstat(value)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function readUtf8Bounded(
  file,
  limit = PACKAGE_PROMPT_LIMIT,
  { label = 'File' } = {},
) {
  const metadata = await fs.stat(file)
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`)
  if (metadata.size > limit) {
    throw new Error(`${label} exceeds the ${limit / 1024} KB prompt payload limit`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of createReadStream(file)) {
    total += chunk.length
    if (total > limit) {
      throw new Error(`${label} exceeds the ${limit / 1024} KB prompt payload limit`)
    }
    chunks.push(chunk)
  }
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error(`${label} must be UTF-8 text`)
  }
  if (content.includes('\0')) throw new Error(`${label} must not contain NUL bytes`)
  return content
}

export async function replaceDirectoryAtomic(source, destination, options = {}) {
  const parent = path.dirname(destination)
  const name = path.basename(destination)
  const temporary = path.join(parent, `.${name}.tmp-${randomUUID()}`)
  const previous = path.join(parent, `.${name}.previous-${randomUUID()}`)
  await fs.mkdir(parent, { recursive: true })
  try {
    await fs.cp(source, temporary, { recursive: true, errorOnExist: true })
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const existed = await pathExists(destination)
  let activated = false
  try {
    if (existed) await fs.rename(destination, previous)
    await fs.rename(temporary, destination)
    activated = true
    const result = await options.afterReplace?.({ destination, existed })
    if (existed) await fs.rm(previous, { recursive: true, force: true })
    return result
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (activated && await pathExists(destination)) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
    }
    if (existed && await pathExists(previous)) {
      await fs.rename(previous, destination).catch(() => {})
    }
    try {
      await options.afterRollback?.({ destination, existed })
    } catch {}
    throw error
  }
}

function parseTopLevelYaml(source, label) {
  const lines = source.split('\n')
  const values = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/)
    if (!match) throw yamlError(label, index, 'expected a top-level key')
    const [, key, raw = ''] = match
    const block = raw.match(/^([|>])([+-]?)$/)
    if (block) {
      const collected = collectIndented(lines, index + 1)
      values[key] = blockScalar(collected.lines, block[1], block[2])
      index = collected.end - 1
      continue
    }
    if (!raw) {
      const collected = collectIndented(lines, index + 1)
      const sequenceLines = collected.lines.filter(entry => entry.trim())
      if (!sequenceLines.length) {
        values[key] = null
      } else if (!sequenceLines.every(entry => /^\s*-\s+/.test(entry))) {
        // Package consumers only use a small set of scalar and sequence fields.
        // Keep valid, nested metadata forward-compatible instead of rejecting a
        // whole package because an unknown field contains a YAML mapping.
        values[key] = {}
      } else {
        values[key] = sequenceLines.map((entry, offset) => {
          const item = entry.match(/^\s*-\s+(.*)$/)
          return parseScalar(item[1], label, index + offset + 1)
        })
      }
      index = collected.end - 1
      continue
    }
    values[key] = raw.trim().startsWith('[')
      ? parseFlowSequence(raw.trim(), label, index)
      : parseScalar(raw, label, index)
  }
  return values
}

function collectIndented(lines, start) {
  const collected = []
  let end = start
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) {
    collected.push(lines[end])
    end += 1
  }
  return { lines: collected, end }
}

function blockScalar(lines, style, chomp) {
  const nonempty = lines.filter(line => line.trim())
  const indent = nonempty.length
    ? Math.min(...nonempty.map(line => line.match(/^\s*/)[0].length))
    : 0
  const stripped = lines.map(line => line.slice(Math.min(indent, line.length)))
  let value = style === '|'
    ? stripped.join('\n')
    : foldLines(stripped)
  value = value.replace(/\n+$/, '')
  if (chomp !== '-') value += '\n'
  return value
}

function foldLines(lines) {
  let output = ''
  for (const line of lines) {
    if (!line) {
      output = output.replace(/ $/, '') + '\n'
    } else {
      output += `${output && !output.endsWith('\n') ? ' ' : ''}${line}`
    }
  }
  return output
}

function parseFlowSequence(value, label, index) {
  if (!value.endsWith(']')) throw yamlError(label, index, 'sequence is not closed')
  const body = value.slice(1, -1).trim()
  if (!body) return []
  const items = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const character of body) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && quote === '"') {
      current += character
      escaped = true
    } else if (quote) {
      current += character
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      current += character
      quote = character
    } else if (character === ',') {
      items.push(parseScalar(current, label, index))
      current = ''
    } else {
      current += character
    }
  }
  if (quote) throw yamlError(label, index, 'quoted sequence item is not closed')
  items.push(parseScalar(current, label, index))
  return items
}

function parseScalar(raw, label, index) {
  const value = stripInlineComment(String(raw).trim())
  if (!value) return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw yamlError(label, index, 'double-quoted scalar is not closed')
    try {
      return JSON.parse(value)
    } catch {
      throw yamlError(label, index, 'double-quoted scalar is invalid')
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw yamlError(label, index, 'single-quoted scalar is not closed')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function stripInlineComment(value) {
  let quote = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
    } else if (quote === '"' && character === '\\') {
      escaped = true
    } else if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1
    } else if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '#' && index > 0 && /\s/.test(value[index - 1])) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

function yamlError(label, index, message) {
  return new Error(`Invalid ${label} frontmatter at line ${index + 1}: ${message}`)
}
