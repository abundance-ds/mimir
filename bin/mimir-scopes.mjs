import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function scopeRoots(options = {}) {
  const home = path.resolve(
    options.home
      || process.env.MIMIR_HOME
      || path.join(os.homedir(), '.mimir'),
  )
  const settings = await readJsonFile(path.join(home, 'settings.json'), {})
  const projectRoot = await resolveProjectRoot(options.cwd || process.cwd())
  const configuredTeamRoot = firstString(settings?.editor?.mimirTeamFolder)
  const requestedTeamRoot = Object.hasOwn(options, 'teamRoot')
    ? String(options.teamRoot || '').trim()
    : String(configuredTeamRoot || '').trim()
  if (requestedTeamRoot && !path.isAbsolute(requestedTeamRoot)) {
    throw new Error('The Mimir Team folder must be an absolute path.')
  }
  const team = requestedTeamRoot
    ? await fs.realpath(requestedTeamRoot).catch(() => path.resolve(requestedTeamRoot))
    : ''
  return {
    home,
    private: path.join(home, 'private'),
    project: projectRoot,
    team,
    projectRoot,
  }
}

export async function resolveProjectRoot(cwd) {
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

export function expandHomePath(value) {
  const input = String(value || '')
  if (input === '~') return os.homedir()
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`Invalid Mimir settings at ${file}: ${error.message}`)
  }
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || ''
}
