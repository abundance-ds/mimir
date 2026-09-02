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
  const projectRoot = await resolveProjectRoot(options.cwd || process.cwd())
  const managedTeam = path.join(home, 'team-graph')
  const team = await isManagedTeam(managedTeam)
    ? await fs.realpath(managedTeam).catch(() => managedTeam)
    : ''
  return {
    home,
    private: path.join(home, 'private'),
    project: projectRoot,
    team,
    projectRoot,
  }
}

async function isManagedTeam(root) {
  const [git, graph, resources, manifest] = await Promise.all([
    fs.stat(path.join(root, '.git')).catch(() => null),
    fs.stat(path.join(root, 'graph')).catch(() => null),
    fs.stat(path.join(root, 'resources')).catch(() => null),
    fs.readFile(path.join(root, 'mimir-team.toml'), 'utf8').catch(() => ''),
  ])
  if (
    !git?.isDirectory()
    || !graph?.isDirectory()
    || !resources?.isDirectory()
    || !/^version\s*=\s*1\s*$/m.test(manifest)
    || !/^name\s*=\s*["'][^"']+["']\s*$/m.test(manifest)
  ) {
    return false
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'remote', 'get-url', 'origin'],
      { timeout: 2_000, windowsHide: true },
    )
    return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)[^/?#]+\/[^/?#]+(?:\.git)?\/?$/i.test(stdout.trim())
  } catch {
    return false
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
