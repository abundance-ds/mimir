import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  humanizePackageName,
  PACKAGE_NAME,
  PACKAGE_PROMPT_LIMIT,
  parsePackageFrontmatter,
  pathExists,
  readUtf8Bounded,
  replaceDirectoryAtomic,
  uniquePhysicalRoots,
} from './mimir-packages.mjs'
import { scopeRoots } from './mimir-scopes.mjs'

export async function listAgents(options = {}) {
  const roots = await agentRoots(options)
  const groups = await Promise.all(uniquePhysicalRoots([
    { scope: 'project', root: roots.project },
    { scope: 'private', root: roots.private },
    { scope: 'team', root: roots.team },
  ]).map(({ scope, root }) => readAgentScope(scope, root)))
  const winner = new Map()
  return groups
    .flat()
    .map((agent) => {
      if (agent.diagnostic) return { ...agent, active: false }
      const active = !winner.has(agent.name)
      const shadowedBy = active ? '' : winner.get(agent.name).scope
      if (active) winner.set(agent.name, agent)
      return { ...agent, active, ...(shadowedBy ? { shadowedBy } : {}) }
    })
    .sort((left, right) => left.name.localeCompare(right.name)
      || scopeRank(left.scope) - scopeRank(right.scope))
}

export async function addAgent(source, scope, options = {}) {
  if (!['private', 'project', 'team'].includes(scope)) {
    throw new Error('Choose one agent scope: --private, --project, or --team.')
  }
  const roots = await agentRoots(options)
  const destinationRoot = roots[scope]
  if (!destinationRoot) throw new Error(`The ${scope} scope is not mounted.`)
  if (scope === 'team' && !await pathExists(roots.scopes.team)) {
    throw new Error(`The Team folder does not exist: ${roots.scopes.team}`)
  }
  const sourcePath = path.resolve(String(source || ''))
  const agent = await readAgent(sourcePath, scope)
  const sourceRoot = await fs.realpath(sourcePath)
  if (!(await fs.stat(sourceRoot)).isDirectory()) {
    throw new Error(`Agent source is not a directory: ${sourcePath}`)
  }
  const destination = path.join(destinationRoot, agent.name)
  if (path.resolve(sourceRoot) === path.resolve(destination)) return agent
  await replaceDirectoryAtomic(sourceRoot, destination)
  return await readAgent(destination, scope)
}

export function formatAgents(agents) {
  if (!agents.length) return 'No agent packages found.'
  return agents.map((agent) => {
    if (agent.diagnostic) {
      return `${agent.name} [${agent.scope}, invalid]\t${agent.diagnostic}`
    }
    const state = agent.active ? '' : `, shadowed by ${agent.shadowedBy}`
    const summary = agent.description || agent.title
    return `${agent.name} [${agent.scope}${state}]${summary ? `\t${summary}` : ''}`
  }).join('\n')
}

export async function agentRoots(options = {}) {
  const scopes = await scopeRoots(options)
  return {
    private: path.join(scopes.private, 'agents'),
    project: path.join(scopes.project, 'agents'),
    team: scopes.team ? path.join(scopes.team, 'agents') : '',
    scopes,
  }
}

async function readAgentScope(scope, root) {
  if (!root) return []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || scope === 'team') return []
    throw error
  }
  const agents = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.')) continue
    const packagePath = path.join(root, entry.name)
    try {
      agents.push(await readAgent(packagePath, scope))
    } catch (error) {
      agents.push({
        name: entry.name,
        scope,
        title: humanizePackageName(entry.name),
        description: '',
        path: path.resolve(packagePath),
        diagnostic: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return agents
}

async function readAgent(packagePath, scope) {
  const name = path.basename(packagePath)
  if (!PACKAGE_NAME.test(name) || name.length > 64) {
    throw new Error('agent folder name must be 1–64 lowercase letters, numbers, and single hyphens')
  }
  const content = await readUtf8Bounded(
    path.join(packagePath, 'AGENT.md'),
    PACKAGE_PROMPT_LIMIT,
    { label: 'AGENT.md' },
  )
  const { frontmatter, body } = parsePackageFrontmatter(content, { label: 'AGENT.md' })
  if (!body.trim()) throw new Error('AGENT.md mission must not be empty')
  const title = optionalString(frontmatter.title, 'title') || humanizePackageName(name)
  const description = optionalString(frontmatter.description, 'description')
  const preset = optionalString(frontmatter.preset, 'preset')
  const args = optionalStringList(frontmatter.args, 'args')
  const skills = optionalStringList(frontmatter.skills, 'skills')
  if (frontmatter.interactive !== undefined && typeof frontmatter.interactive !== 'boolean') {
    throw new Error('AGENT.md frontmatter field interactive must be a boolean')
  }
  return {
    name,
    scope,
    title,
    description,
    preset,
    args,
    skills,
    interactive: frontmatter.interactive === true,
    path: path.resolve(packagePath),
  }
}

function optionalString(value, field) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new Error(`AGENT.md frontmatter field ${field} must be a string`)
  }
  return value.trim()
}

function optionalStringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`AGENT.md frontmatter field ${field} must be a string list`)
  }
  return value.map(item => item.trim())
}

function scopeRank(scope) {
  return scope === 'project' ? 0 : scope === 'private' ? 1 : 2
}
