import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function listSkills(options = {}) {
  const roots = await skillRoots(options)
  const groups = await Promise.all([
    readScope('catalog', roots.catalog),
    readScope('personal', roots.personal),
    readScope('project', roots.project),
  ])
  const skills = groups.flat().sort((left, right) => left.name.localeCompare(right.name))
  assertUniqueSkills(skills)
  return skills
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
  if (!['catalog', 'personal', 'project'].includes(scope)) {
    throw new Error('Choose one skill scope: --catalog, --personal, or --project.')
  }
  const sourcePath = path.resolve(String(source || ''))
  const skill = await readSkill(sourcePath, scope)
  const sourceRoot = await fs.realpath(sourcePath)
  if (!(await fs.stat(sourceRoot)).isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourcePath}`)
  }
  const roots = await skillRoots(options)
  await assertNameAvailable(skill.name, scope, roots)

  const destinationRoot = roots[scope]
  await fs.mkdir(destinationRoot, { recursive: true })
  const destination = path.join(destinationRoot, skill.name)
  const temporary = path.join(destinationRoot, `.${skill.name}.tmp-${randomUUID()}`)
  const previous = path.join(destinationRoot, `.${skill.name}.previous-${randomUUID()}`)
  await fs.cp(sourceRoot, temporary, { recursive: true, errorOnExist: true })

  const existing = await pathType(destination)
  if (existing) {
    await materializeSkillRevision(await readSkill(destination, scope), roots)
  }
  let installed = false
  try {
    if (existing) await fs.rename(destination, previous)
    await fs.rename(temporary, destination)
    installed = true
    await writeSkillMetadata(destination, {
      name: skill.name,
      scope,
      revision: await packageRevision(destination),
      updatedAt: new Date().toISOString(),
      updatedBy: options.author || process.env.USER || process.env.USERNAME || 'unknown',
    })
    const [added] = await readScope(scope, destinationRoot)
      .then(skills => skills.filter(entry => entry.name === skill.name))
    await materializeSkillRevision(added, roots)
    if (scope !== 'project') await refreshNativeSkills(options)
    if (existing) await fs.rm(previous, { recursive: true, force: true })
    return added
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (installed && await pathType(destination)) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
    }
    if (existing && await pathType(previous)) {
      await fs.rename(previous, destination).catch(() => {})
    }
    if (scope !== 'project') await refreshNativeSkills(options).catch(() => {})
    throw error
  }
}

export async function refreshNativeSkills(options = {}) {
  const roots = await skillRoots(options)
  const skills = (await Promise.all([
    readScope('catalog', roots.catalog),
    readScope('personal', roots.personal),
  ])).flat()
  assertUniqueSkills(skills)

  const nativeRoot = path.resolve(
    options.nativeRoot
      || process.env.MIMIR_NATIVE_SKILLS_DIR
      || path.join(os.homedir(), '.agents', 'skills'),
  )
  const manifestPath = path.join(roots.base, 'native-projection.json')
  const previous = await readJsonFile(manifestPath, { entries: [] })
  const previousEntries = validateProjectionEntries(previous?.entries, nativeRoot)
  const desired = []
  await fs.mkdir(nativeRoot, { recursive: true })

  for (const skill of skills) {
    const revision = await materializeSkillRevision(skill, roots)
    const linkPath = path.join(nativeRoot, skill.name)
    const current = await declaredLinkTarget(linkPath)
    const existing = await pathType(linkPath)
    const owned = previousEntries.find(entry => entry.path === linkPath)
    if (existing && (
      existing !== 'link'
      || !owned
      || !current
      || path.resolve(current) !== path.resolve(owned.target)
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
  return { root: nativeRoot, count: desired.length }
}

export async function projectSkillPaths(options = {}) {
  const roots = await skillRoots(options)
  return await Promise.all(
    (await readScope('project', roots.project))
      .map(async skill => (await materializeSkillRevision(skill, roots)).path),
  )
}

export async function prepareSkills(client, options = {}) {
  if (!['codex', 'claude', 'pi', 'gemini'].includes(client)) {
    throw new Error(`Unsupported skill client '${client}'.`)
  }
  const roots = await skillRoots(options)
  const native = await refreshNativeSkills(options)
  const skills = await listSkills(options)
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
  const home = path.resolve(
    options.home
      || process.env.MIMIR_HOME
      || path.join(os.homedir(), '.mimir'),
  )
  const base = path.join(home, 'skills')
  const projectRoot = await resolveProjectRoot(options.cwd || process.cwd())
  const projectKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 20)
  const settingsCatalogRoot = await catalogRootFromSettings(home)
  const catalog = path.resolve(
    options.catalogRoot
      || process.env.MIMIR_SKILLS_CATALOG_ROOT
      || settingsCatalogRoot
      || path.join(base, 'catalog'),
  )
  return {
    base,
    catalog,
    personal: path.join(base, 'personal'),
    project: path.join(base, 'projects', projectKey),
    projectKey,
    projectRoot,
  }
}

async function catalogRootFromSettings(home) {
  const settings = await readJsonFile(path.join(home, 'settings.json'), {})
  const configured = settings?.skills?.catalogRoot
  if (configured === undefined) return ''
  if (
    typeof configured !== 'string'
    || !configured.trim()
    || !path.isAbsolute(configured)
  ) {
    throw new Error('settings.skills.catalogRoot must be an absolute path.')
  }
  return configured
}

async function readScope(scope, root) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
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
      error.message = `${skillPath}: ${error.message}`
      throw error
    }
  }
  return skills
}

async function readSkill(skillPath, scope) {
  const content = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8')
  const frontmatter = parseFrontmatter(content)
  const name = String(frontmatter.name || '').trim()
  const description = String(frontmatter.description || '').trim()
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

function parseFrontmatter(content) {
  const normalized = String(content || '').replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md must start with YAML frontmatter')
  }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed')
  const lines = normalized.slice(4, end).split('\n')
  const values = {}
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (!match) continue
    const [, key, raw = ''] = match
    if (raw === '|' || raw === '>') {
      const block = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim())
        index += 1
      }
      values[key] = raw === '>' ? block.join(' ') : block.join('\n')
    } else {
      values[key] = unquoteYaml(raw.trim())
    }
  }
  return values
}

function unquoteYaml(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

async function assertNameAvailable(name, targetScope, roots) {
  const all = [
    ...(await readScope('catalog', roots.catalog)),
    ...(await readScope('personal', roots.personal)),
  ]
  if (targetScope === 'project') {
    all.push(...await readScope('project', roots.project))
  } else {
    const projectRoots = path.join(roots.base, 'projects')
    let projectKeys = []
    try {
      projectKeys = (await fs.readdir(projectRoots, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const key of projectKeys) {
      all.push(...await readScope('project', path.join(projectRoots, key)))
    }
  }
  const destination = path.resolve(path.join(roots[targetScope], name))
  const conflict = all.find(skill => (
    skill.name === name && path.resolve(skill.path) !== destination
  ))
  if (conflict) {
    throw new Error(`Skill '${name}' already exists in ${conflict.scope}. Skill names are unique across scopes.`)
  }
}

function assertUniqueSkills(skills) {
  const seen = new Map()
  for (const skill of skills) {
    const existing = seen.get(skill.name)
    if (existing) {
      throw new Error(
        `Skill '${skill.name}' exists in both ${existing.scope} and ${skill.scope}. Rename one skill.`,
      )
    }
    seen.set(skill.name, skill)
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

async function resolveProjectRoot(cwd) {
  const resolved = path.resolve(cwd)
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', resolved, 'rev-parse', '--show-toplevel'],
      { timeout: 2_000, windowsHide: true },
    )
    return await fs.realpath(stdout.trim())
  } catch {
    return await fs.realpath(resolved).catch(() => resolved)
  }
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
    hash.update(type === 'link'
      ? await fs.readlink(path.join(root, relative))
      : await fs.readFile(path.join(root, relative)))
  }
  return hash.digest('hex')
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
