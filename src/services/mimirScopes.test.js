import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scopeRoots } from '../../bin/mimir-scopes.mjs'

describe('Mimir scope roots', () => {
  let root

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('returns only Project, Private, and the valid fixed Team root', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-scopes-'))
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    const team = path.join(home, 'team-graph')
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(path.join(team, 'graph'), { recursive: true })
    await fs.mkdir(path.join(team, 'resources'), { recursive: true })
    await fs.writeFile(path.join(team, 'mimir-team.toml'), 'version = 1\nname = "Test"\n')
    execFileSync('git', ['init', team])
    execFileSync('git', ['-C', team, 'remote', 'add', 'origin', 'https://github.com/test/team-graph.git'])

    const roots = await scopeRoots({ home, cwd: project })
    const resolvedProject = await fs.realpath(project)
    const resolvedTeam = await fs.realpath(team)

    expect(roots).toMatchObject({
      home,
      private: path.join(home, 'private'),
      project: resolvedProject,
      projectRoot: resolvedProject,
      team: resolvedTeam,
    })
    expect(roots).not.toHaveProperty('legacy')
  })

  it('ignores retired scope settings', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-scopes-'))
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      path.join(home, 'settings.json'),
      `${JSON.stringify({
        editor: { mimirTeamGraphFolder: path.join(root, 'old-team') },
        mimirTeamFolder: path.join(root, 'old-top-level-team'),
        skills: { catalogRoot: path.join(root, 'old-catalog') },
      })}\n`,
    )

    await expect(scopeRoots({ home, cwd: project })).resolves.toMatchObject({ team: '' })
  })
})
