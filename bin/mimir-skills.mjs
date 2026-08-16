import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PACKAGE_PROMPT_LIMIT,
  parsePackageFrontmatter,
  readUtf8Bounded,
  replaceDirectoryAtomic,
  uniquePhysicalRoots,
} from './mimir-packages.mjs'
import { scopeRoots } from './mimir-scopes.mjs'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function listSkills(options = {}) {
  const roots = await skillRoots(options)
  const groups = await Promise.all(uniquePhysicalRoots([
    { scope: 'project', root: roots.project },
    { scope: 'private', root: roots.private },
    { scope: 'team', root: roots.team },
  ]).map(({ scope, root }) => readScopePaths(scope, [root], options)))
  const visible = []
  const seen = new Set()
  for (const skill of groups.flat()) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    visible.push(skill)
  }
  return visible.sort((left, right) => left.name.localeCompare(right.name))
}

export async function findSkill(query, options = {}) {
  const normalized = String(query || '').trim().toLowerCase()
  if (!normalized) return { matches: await listSkills(options) }
  const skills = await listSkills(options)
  const exact = skills.find(skill => skill.name.toLowerCase() === normalized)
  if (exact) return { skill: await materializeFoundSkill(exact, options) }

  const terms = tokenize(normalized)
  const ranked = skills
    .map(skill => ({ skill, score: scoreSkill(skill, normalized, terms) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.skill.name.localeCompare(right.skill.name))
  if (ranked.length === 1 || (
    ranked.length > 1 && ranked[0].score >= ranked[1].score + 40
  )) {
    return { skill: await materializeFoundSkill(ranked[0].skill, options) }
  }
  return { matches: ranked.slice(0, 5).map(entry => entry.skill) }
}

export async function addSkill(source, scope, options = {}) {
  if (!['private', 'project', 'team'].includes(scope)) {
    throw new Error('Choose one skill scope: --private, --project, or --team.')
  }
  const sourcePath = path.resolve(String(source || ''))
  const skill = await readSkill(sourcePath, scope)
  const sourceRoot = await fs.realpath(sourcePath)
  if (!(await fs.stat(sourceRoot)).isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourcePath}`)
  }
  const roots = await skillRoots(options)
  await assertNameAvailable(skill.name, scope, roots)
  if (scope === 'team' && !await pathType(roots.scopes.team)) {
    throw new Error(`The Team folder does not exist: ${roots.scopes.team}`)
  }

  const destinationRoot = roots[scope]
  const destination = path.join(destinationRoot, skill.name)
  const existing = await pathType(destination)
  if (existing) {
    await materializeSkillRevision(await readSkill(destination, scope), roots)
  }
  return await replaceDirectoryAtomic(sourceRoot, destination, {
    afterReplace: async () => {
      await writeSkillMetadata(destination, {
        name: skill.name,
        scope,
        revision: await packageRevision(destination),
        updatedAt: new Date().toISOString(),
        updatedBy: options.author || process.env.USER || process.env.USERNAME || 'unknown',
      })
      const [added] = await readScope(scope, destinationRoot, options)
        .then(skills => skills.filter(entry => entry.name === skill.name))
      await materializeSkillRevision(added, roots)
      if (scope !== 'project') await refreshNativeSkills(options)
      return added
    },
    afterRollback: async () => {
      if (scope !== 'project') await refreshNativeSkills(options)
    },
  })
}

export async function refreshNativeSkills(options = {}) {
  const roots = await skillRoots(options)
  const skills = []
  const seen = new Set()
  for (const skill of (await Promise.all([
    readScopePaths('private', roots.privateSources, options),
    readScopePaths('team', roots.teamSources, options),
  ])).flat()) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    skills.push(skill)
  }

  const nativeRoot = path.resolve(
    options.nativeRoot
      || process.env.MIMIR_NATIVE_SKILLS_DIR
      || path.join(os.homedir(), '.agents', 'skills'),
  )
  const manifestPath = path.join(roots.base, 'native-projection.json')
  const previous = await readJsonFile(manifestPath, { entries: [] })
  const previousEntries = validateProjectionEntries(previous?.entries, nativeRoot)
  const revisionsRoot = path.join(roots.base, 'revisions')
  const desired = []
  await fs.mkdir(nativeRoot, { recursive: true })

  for (const skill of skills) {
    const revision = await materializeSkillRevision(skill, roots)
    const linkPath = path.join(nativeRoot, skill.name)
    const current = await declaredLinkTarget(linkPath)
    const existing = await pathType(linkPath)
    const owned = previousEntries.find(entry => entry.path === linkPath)
    const manifestOwnsCurrent = owned
      && current
      && path.resolve(current) === path.resolve(owned.target)
    const revisionOwnsCurrent = current
      && isManagedRevisionTarget(current, revisionsRoot, skill.name)
    if (existing && (
      existing !== 'link'
      || (!manifestOwnsCurrent && !revisionOwnsCurrent)
    )) {
      throw new Error(
        `Cannot expose '${skill.name}': ${linkPath} already exists and is not managed by Mimir.`,
      )
    }
    const target = await fs.realpath(revision.path)
    desired.push({ name: skill.name, path: linkPath, target, current })
  }

  const stale = []
  for (const entry of previousEntries) {
    if (desired.some(candidate => candidate.path === entry.path)) continue
    const current = await declaredLinkTarget(entry.path)
    const existing = await pathType(entry.path)
    if (
      existing === 'link'
      && current
      && path.resolve(current) === path.resolve(entry.target)
    ) {
      stale.push({ path: entry.path, current })
    }
  }

  const changed = []
  try {
    for (const entry of desired) {
      if (entry.current && path.resolve(entry.current) === path.resolve(entry.target)) continue
      changed.push({ path: entry.path, previous: entry.current })
      if (entry.current) await fs.unlink(entry.path)
      await fs.symlink(
        entry.target,
        entry.path,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    }
    for (const entry of stale) {
      changed.push({ path: entry.path, previous: entry.current })
      await fs.unlink(entry.path)
    }
    await writeJsonAtomic(manifestPath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: desired.map(({ name, path: linkPath, target }) => ({
        name,
        path: linkPath,
        target,
      })),
    })
  } catch (error) {
    for (const entry of changed.reverse()) {
      if (await pathType(entry.path) === 'link') {
        await fs.unlink(entry.path).catch(() => {})
      }
      if (entry.previous) {
        await fs.symlink(
          entry.previous,
          entry.path,
          process.platform === 'win32' ? 'junction' : 'dir',
        ).catch(() => {})
      }
    }
    throw error
  }
  return {
    root: nativeRoot,
    count: desired.length,
    ...(options.diagnostics?.length ? { diagnostics: options.diagnostics } : {}),
  }
}

export async function projectSkillPaths(options = {}) {
  const roots = await skillRoots(options)
  return await Promise.all(
    (await readScopePaths('project', roots.projectSources, options))
      .map(async skill => (await materializeSkillRevision(skill, roots)).path),
  )
}

export async function prepareSkills(client, options = {}) {
  if (!['codex', 'claude', 'pi', 'gemini'].includes(client)) {
    throw new Error(`Unsupported skill client '${client}'.`)
  }
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : []
  const scanOptions = { ...options, diagnostics }
  const roots = await skillRoots(scanOptions)
  const native = await refreshNativeSkills(scanOptions)
  const skills = await listSkills(scanOptions)
  const revisions = await Promise.all(
    skills.map(skill => materializeSkillRevision(skill, roots)),
  )
  const projectSkills = revisions.filter(skill => skill.scope === 'project')
  let claudeRoot
  if (client === 'claude' && skills.length) {
    claudeRoot = path.join(roots.base, 'snapshots', 'claude', roots.projectKey)
    await materializeClaudeSnapshot(claudeRoot, options)
  }
  return {
    client,
    nativeRoot: native.root,
    nativeSkills: native.count,
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(claudeRoot ? { claudeRoot } : {}),
    projectSkillFiles: client === 'pi'
      ? projectSkills.map(skill => path.join(skill.path, 'SKILL.md'))
      : [],
  }
}

export async function materializeClaudeSnapshot(destination, options = {}) {
  const roots = await skillRoots(options)
  const target = path.resolve(destination)
  const snapshotsRoot = path.resolve(path.join(roots.base, 'snapshots', 'claude'))
  if (target !== snapshotsRoot && !target.startsWith(`${snapshotsRoot}${path.sep}`)) {
    throw new Error('Claude snapshots must stay inside Mimir skill storage.')
  }
  const skills = await listSkills(options)
  const revisions = await Promise.all(
    skills.map(skill => materializeSkillRevision(skill, roots)),
  )
  const temporary = `${target}.tmp-${randomUUID()}`
  const previous = `${target}.previous-${randomUUID()}`
  const skillRoot = path.join(temporary, '.claude', 'skills')
  await fs.mkdir(skillRoot, { recursive: true })
  for (const skill of revisions) {
    await fs.symlink(
      skill.path,
      path.join(skillRoot, skill.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
  await fs.writeFile(
    path.join(temporary, '.mimir-snapshot.json'),
    `${JSON.stringify({ version: 1, skills: revisions.map(skill => skill.name) }, null, 2)}\n`,
  )
  const existing = await pathType(target)
  try {
    if (existing) {
      if (!await pathType(path.join(target, '.mimir-snapshot.json'))) {
        throw new Error(`Refusing to replace unowned Claude directory: ${target}`)
      }
      await fs.rename(target, previous)
    }
    await fs.rename(temporary, target)
    if (existing) await fs.rm(previous, { recursive: true, force: true })
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (existing && !await pathType(target) && await pathType(previous)) {
      await fs.rename(previous, target).catch(() => {})
    }
    throw error
  }
  return { root: target, count: revisions.length }
}

export function formatSkill(skill) {
  return [
    `${skill.name} [${skill.scope}]`,
    `Path: ${skill.path}`,
    '',
    skill.content.trimEnd(),
  ].join('\n')
}

export function formatSkillMatches(skills, { limit = 5 } = {}) {
  if (!skills.length) return 'No matching skills.'
  return skills
    .slice(0, limit)
    .map(skill => `${skill.name} [${skill.scope}]\t${skill.description}`)
    .join('\n')
}

export async function skillRoots(options = {}) {
  const scopes = await scopeRoots(options)
  const home = scopes.home
  const base = path.join(home, 'skills')
  const privateRoot = path.join(scopes.private, 'skills')
  const projectRoot = scopes.projectRoot
  const projectKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 20)
  const project = path.join(projectRoot, 'skills')
  const team = scopes.team ? path.join(scopes.team, 'skills') : ''
  return {
    base,
    private: privateRoot,
    project,
    team,
    privateSources: [privateRoot],
    projectSources: [project],
    teamSources: team ? [team] : [],
    projectKey,
    projectRoot,
    scopes,
  }
}

async function readScopePaths(scope, roots, options = {}) {
  const skills = []
  const seen = new Set()
  for (const root of roots) {
    for (const skill of await readScope(scope, root, options)) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      skills.push(skill)
    }
  }
  return skills
}

async function readScope(scope, root, options = {}) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || scope === 'team') return []
    throw error
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const skillPath = path.join(root, entry.name)
    try {
      skills.push(await readSkill(skillPath, scope))
    } catch (error) {
      recordDiagnostic(options, skillPath, error)
    }
  }
  return skills
}

async function readSkill(skillPath, scope) {
  const source = path.join(skillPath, 'SKILL.md')
  const content = await readUtf8Bounded(source, PACKAGE_PROMPT_LIMIT, { label: 'SKILL.md' })
  const { frontmatter } = parsePackageFrontmatter(content, {
    label: 'SKILL.md',
    required: true,
  })
  if (typeof frontmatter.name !== 'string') {
    throw new Error('SKILL.md frontmatter must include a string name')
  }
  if (typeof frontmatter.description !== 'string') {
    throw new Error('SKILL.md frontmatter must include a string description')
  }
  const name = frontmatter.name.trim()
  const description = frontmatter.description.trim()
  if (!name) throw new Error('SKILL.md frontmatter must include name')
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new Error('skill name must be 1–64 lowercase letters, numbers, and single hyphens')
  }
  if (name !== path.basename(skillPath)) {
    throw new Error(`skill name '${name}' must match directory '${path.basename(skillPath)}'`)
  }
  if (!description) throw new Error('SKILL.md frontmatter must include description')
  if (description.length > 1024) throw new Error('skill description must be at most 1024 characters')
  return {
    name,
    description,
    scope,
    path: path.resolve(skillPath),
    content,
  }
}

function recordDiagnostic(options, skillPath, error) {
  if (!Array.isArray(options.diagnostics)) return
  const message = `${skillPath}: ${error instanceof Error ? error.message : String(error)}`
  if (!options.diagnostics.includes(message)) options.diagnostics.push(message)
}

async function assertNameAvailable(name, targetScope, roots) {
  if (!roots[targetScope]) {
    throw new Error(`The ${targetScope} scope is not mounted.`)
  }
}

function tokenize(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [])]
}

function scoreSkill(skill, query, terms) {
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  let score = name.includes(query) ? 80 : 0
  for (const term of terms) {
    if (name === term) score += 50
    else if (name.startsWith(term)) score += 30
    else if (name.includes(term)) score += 20
    if (description.includes(term)) score += 8
  }
  return score
}


async function packageRevision(root) {
  const entries = []
  const realRoot = await fs.realpath(root)
  await walk(root, root, realRoot, entries)
  const hash = createHash('sha256')
  for (const entry of entries.sort((left, right) => left.relative.localeCompare(right.relative))) {
    const { relative, type } = entry
    if (relative === '.mimir.json' || relative === '.mimir-revision.json') continue
    hash.update(type)
    hash.update(relative)
    const absolute = path.join(root, relative)
    if (type === 'link') hash.update(await fs.readlink(absolute))
    else await updateHashFromFile(hash, absolute)
  }
  return hash.digest('hex')
}

async function updateHashFromFile(hash, file) {
  for await (const chunk of createReadStream(file)) hash.update(chunk)
}

async function walk(root, current, realRoot, entries) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) await walk(root, absolute, realRoot, entries)
    else if (entry.isFile()) entries.push({ relative: path.relative(root, absolute), type: 'file' })
    else if (entry.isSymbolicLink()) {
      const target = await fs.realpath(absolute).catch((error) => {
        throw new Error(`Skill contains an invalid symlink at ${absolute}: ${error.message}`)
      })
      if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error(`Skill symlink escapes its package: ${absolute}`)
      }
      entries.push({ relative: path.relative(root, absolute), type: 'link' })
    }
  }
}

async function materializeSkillRevision(skill, roots) {
  const revision = await packageRevision(skill.path)
  const destination = path.join(
    roots.base,
    'revisions',
    skill.scope,
    skill.name,
    revision,
  )
  if (await pathType(destination)) {
    await validateMaterializedRevision(destination, skill, revision)
    return { ...skill, path: destination, revision }
  }

  const temporary = `${destination}.tmp-${randomUUID()}`
  let created = false
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.cp(await fs.realpath(skill.path), temporary, {
      recursive: true,
      errorOnExist: true,
    })
    const copiedRevision = await packageRevision(temporary)
    if (copiedRevision !== revision) {
      throw new Error(`Skill '${skill.name}' changed while its revision was being prepared.`)
    }
    await fs.writeFile(
      path.join(temporary, '.mimir-revision.json'),
      `${JSON.stringify({
        version: 1,
        name: skill.name,
        scope: skill.scope,
        revision,
      }, null, 2)}\n`,
    )
    await fs.rename(temporary, destination)
    created = true
    await makeReadOnly(destination)
  } catch (error) {
    if (created) {
      await makeWritable(destination).catch(() => {})
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
    }
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (['EEXIST', 'ENOTEMPTY'].includes(error?.code) && await pathType(destination)) {
      await validateMaterializedRevision(destination, skill, revision)
      return { ...skill, path: destination, revision }
    }
    throw error
  }
  return { ...skill, path: destination, revision }
}

async function materializeFoundSkill(skill, options) {
  return await materializeSkillRevision(skill, await skillRoots(options))
}

async function validateMaterializedRevision(destination, skill, revision) {
  const metadata = await readJsonFile(
    path.join(destination, '.mimir-revision.json'),
    null,
  )
  if (
    metadata?.version !== 1
    || metadata?.name !== skill.name
    || metadata?.scope !== skill.scope
    || metadata?.revision !== revision
  ) {
    throw new Error(`Refusing to use invalid skill revision: ${destination}`)
  }
  if (await packageRevision(destination) !== revision) {
    throw new Error(`Skill revision content was modified: ${destination}`)
  }
}

async function makeReadOnly(target) {
  const metadata = await fs.lstat(target)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await makeReadOnly(path.join(target, entry))
    }
  }
  await fs.chmod(target, metadata.mode & ~0o222)
}

async function makeWritable(target) {
  const metadata = await fs.lstat(target)
  if (metadata.isSymbolicLink()) return
  await fs.chmod(target, metadata.mode | 0o200)
  if (metadata.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await makeWritable(path.join(target, entry))
    }
  }
}

async function writeSkillMetadata(destination, metadata) {
  await writeJsonAtomic(path.join(destination, '.mimir.json'), {
    version: 1,
    ...metadata,
  })
}

async function writeJsonAtomic(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${randomUUID()}`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, destination)
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`Invalid Mimir skill state at ${file}: ${error.message}`)
  }
}

function validateProjectionEntries(entries, nativeRoot) {
  if (!Array.isArray(entries)) {
    throw new Error('Invalid Mimir native skill projection: entries must be an array.')
  }
  return entries.map((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    const entryPath = typeof entry?.path === 'string' ? path.resolve(entry.path) : ''
    const target = typeof entry?.target === 'string' ? path.resolve(entry.target) : ''
    if (
      !SKILL_NAME.test(name)
      || entryPath !== path.join(nativeRoot, name)
      || !target
    ) {
      throw new Error('Invalid Mimir native skill projection entry.')
    }
    return { name, path: entryPath, target }
  })
}

function isManagedRevisionTarget(target, revisionsRoot, skillName) {
  const relative = path.relative(path.resolve(revisionsRoot), path.resolve(target))
  const parts = relative.split(path.sep)
  return parts.length === 3
    && parts[0]
    && parts[1] === skillName
    && /^[a-f0-9]{64}$/.test(parts[2])
}

async function pathType(value) {
  try {
    return (await fs.lstat(value)).isSymbolicLink() ? 'link' : 'entry'
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

async function declaredLinkTarget(value) {
  try {
    const target = await fs.readlink(value)
    return path.resolve(path.dirname(value), target)
  } catch (error) {
    if (['EINVAL', 'ENOENT'].includes(error?.code)) return ''
    throw error
  }
}
