import { invoke } from '@tauri-apps/api/core'
import { projectDir } from '../dataDir'
import yaml from 'js-yaml'

export const ISSUE_STATUSES = ['backlog', 'plan', 'in-progress', 'review', 'done']
export const COLUMN_STATUSES = ['backlog', 'plan', 'in-progress', 'review', 'done']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export const STATUS_LABELS = {
  backlog: 'Backlog',
  plan: 'Plan',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
}

export const PRIORITY_LABELS = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

// ---------------------------------------------------------------------------
// YAML parsing
// ---------------------------------------------------------------------------

export function parseBoardEntry(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)

  if (!match) {
    const heading = raw.match(/^#\s+(.+)$/m)
    const title = heading ? heading[1].trim() : raw.slice(0, 60).trim()
    return {
      meta: normalizeKnowledgeMeta({ title }),
      body: raw,
    }
  }

  let meta
  try {
    meta = yaml.load(match[1]) || {}
  } catch {
    return { meta: normalizeKnowledgeMeta({}), body: raw }
  }

  const body = match[2]

  if (meta.type === 'issue') {
    const { meta: normalized } = validateIssueMeta(meta)
    return { meta: normalized, body }
  }

  return { meta: normalizeKnowledgeMeta(meta), body }
}

export function serializeEntry(meta, body) {
  const yamlStr = yaml.dump(meta, { lineWidth: -1, quotingType: '"' })
  return `---\n${yamlStr}---\n\n${body}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateIssueMeta(meta) {
  const errors = []
  const m = { ...meta }

  if (m.type !== 'issue') errors.push('type must be "issue"')
  if (!m.title || typeof m.title !== 'string') errors.push('title is required')

  if (!ISSUE_STATUSES.includes(m.status)) m.status = 'backlog'
  if (!PRIORITIES.includes(m.priority)) m.priority = 'normal'

  if (!Array.isArray(m.tags)) m.tags = []
  if (!Array.isArray(m.links)) m.links = []
  if (!Array.isArray(m.deliverables)) m.deliverables = []
  if (!Array.isArray(m.sources)) m.sources = []
  if (m.dueDate && typeof m.dueDate !== 'string') m.dueDate = ''
  if (!m.origin || typeof m.origin !== 'object' || Array.isArray(m.origin)) m.origin = {}
  if (!m.created) m.created = new Date().toISOString()
  m.updated = new Date().toISOString()

  return { valid: errors.length === 0, errors, meta: m }
}

export function normalizeKnowledgeMeta(meta) {
  const m = { ...meta }
  m.type = 'knowledge'
  if (!m.title || typeof m.title !== 'string') m.title = ''
  if (!Array.isArray(m.tags)) m.tags = []
  if (!Array.isArray(m.sources)) m.sources = []
  if (!m.created) m.created = new Date().toISOString()
  m.updated = new Date().toISOString()
  return m
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateEntryId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let id = ''
  for (let i = 0; i < 7; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export async function issuesDir(projectId) {
  return `${await projectDir(projectId)}/issues`
}

export async function knowledgeDir(projectId) {
  return `${await projectDir(projectId)}/knowledge`
}

export async function ensureIssuesDir(projectId) {
  const dir = await issuesDir(projectId)
  await invoke('create_dir', { path: dir })
  return dir
}

export async function ensureKnowledgeDir(projectId) {
  const dir = await knowledgeDir(projectId)
  await invoke('create_dir', { path: dir })
  return dir
}

async function discoverFromDir(dir) {
  const entries = []
  let listing
  try { listing = await invoke('list_dir', { path: dir }) } catch { return entries }
  for (const item of listing) {
    if (item.is_dir || !item.name.endsWith('.md')) continue
    try {
      const { content } = await invoke('read_text_file', { path: item.path })
      const { meta, body } = parseBoardEntry(content)
      entries.push({ id: item.name.replace(/\.md$/, ''), meta, body, path: item.path })
    } catch (err) {
      console.warn(`Board: skipping ${item.name}:`, err)
    }
  }
  return entries
}

export async function discoverEntries(projectId) {
  const [fromIssues, fromKnowledge] = await Promise.all([
    discoverFromDir(await ensureIssuesDir(projectId)),
    discoverFromDir(await ensureKnowledgeDir(projectId)),
  ])
  const entries = [...fromIssues, ...fromKnowledge]
  entries.sort((a, b) => new Date(b.meta.updated) - new Date(a.meta.updated))
  return entries
}

export async function readEntry(projectId, entryId) {
  const dirs = [await issuesDir(projectId), await knowledgeDir(projectId)]
  for (const dir of dirs) {
    try {
      const { content } = await invoke('read_text_file', { path: `${dir}/${entryId}.md` })
      const { meta, body } = parseBoardEntry(content)
      return { id: entryId, meta, body }
    } catch {}
  }
  throw new Error(`Entry not found: ${entryId}`)
}

export async function writeEntry(projectId, entryId, meta, body) {
  const resolvedId = entryId || generateEntryId()
  const isNew = !entryId
  let finalMeta

  if (meta.type === 'issue') {
    const { valid, errors, meta: normalized } = validateIssueMeta(meta)
    if (!valid) throw new Error(`Invalid issue: ${errors.join(', ')}`)
    finalMeta = normalized
  } else {
    finalMeta = normalizeKnowledgeMeta(meta)
  }

  finalMeta.updated = new Date().toISOString()
  if (isNew && !finalMeta.created) finalMeta.created = new Date().toISOString()

  const content = serializeEntry(finalMeta, body || '')
  const dir = meta.type === 'issue'
    ? await ensureIssuesDir(projectId)
    : await ensureKnowledgeDir(projectId)
  await invoke('write_text_file', { path: `${dir}/${resolvedId}.md`, content })

  return resolvedId
}

export async function deleteEntry(projectId, entryId, type) {
  const dir = type === 'issue'
    ? await issuesDir(projectId)
    : await knowledgeDir(projectId)
  await invoke('delete_path', { path: `${dir}/${entryId}.md` })
}

export async function moveEntry(projectId, entryId, newStatus) {
  if (!ISSUE_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`)
  }

  const entry = await readEntry(projectId, entryId)
  if (entry.meta.type !== 'issue') {
    throw new Error('Only issues can be moved between statuses')
  }

  entry.meta.status = newStatus
  entry.meta.updated = new Date().toISOString()
  await writeEntry(projectId, entryId, entry.meta, entry.body)
}

// ---------------------------------------------------------------------------
// Folder-local variants (stores data in <folder>/.mim/ instead of global dir)
// ---------------------------------------------------------------------------

export async function discoverEntriesFromFolder(basePath) {
  const [fromIssues, fromKnowledge] = await Promise.all([
    discoverFromDir(`${basePath}/issues`),
    discoverFromDir(`${basePath}/knowledge`),
  ])
  const entries = [...fromIssues, ...fromKnowledge]
  entries.sort((a, b) => new Date(b.meta.updated) - new Date(a.meta.updated))
  return entries
}

export async function writeEntryToFolder(basePath, entryId, meta, body) {
  const resolvedId = entryId || generateEntryId()
  const isNew = !entryId
  let finalMeta

  if (meta.type === 'issue') {
    const { valid, errors, meta: normalized } = validateIssueMeta(meta)
    if (!valid) throw new Error(`Invalid issue: ${errors.join(', ')}`)
    finalMeta = normalized
  } else {
    finalMeta = normalizeKnowledgeMeta(meta)
  }

  finalMeta.updated = new Date().toISOString()
  if (isNew && !finalMeta.created) finalMeta.created = new Date().toISOString()

  const dir = meta.type === 'issue' ? `${basePath}/issues` : `${basePath}/knowledge`
  await invoke('create_dir', { path: dir })
  const content = serializeEntry(finalMeta, body || '')
  await invoke('write_text_file', { path: `${dir}/${resolvedId}.md`, content })

  return resolvedId
}

export async function deleteEntryFromFolder(basePath, entryId, type) {
  const dir = type === 'issue' ? `${basePath}/issues` : `${basePath}/knowledge`
  await invoke('delete_path', { path: `${dir}/${entryId}.md` })
}

export async function readEntryFromFolder(basePath, entryId) {
  const dirs = [`${basePath}/issues`, `${basePath}/knowledge`]
  for (const dir of dirs) {
    try {
      const { content } = await invoke('read_text_file', { path: `${dir}/${entryId}.md` })
      const { meta, body } = parseBoardEntry(content)
      return { id: entryId, meta, body }
    } catch {}
  }
  throw new Error(`Entry not found: ${entryId}`)
}

export async function moveEntryInFolder(basePath, entryId, newStatus) {
  if (!ISSUE_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`)
  }
  const entry = await readEntryFromFolder(basePath, entryId)
  if (entry.meta.type !== 'issue') {
    throw new Error('Only issues can be moved between statuses')
  }
  entry.meta.status = newStatus
  entry.meta.updated = new Date().toISOString()
  await writeEntryToFolder(basePath, entryId, entry.meta, entry.body)
}
