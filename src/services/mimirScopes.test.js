import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scopeRoots } from '../../bin/mimir-scopes.mjs'

describe('Mimir scope roots', () => {
  let root

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('returns only Project, Private, and configured Team roots', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-scopes-'))
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    const team = path.join(root, 'team')
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      path.join(home, 'settings.json'),
      `${JSON.stringify({ editor: { mimirTeamFolder: team } })}\n`,
    )

    const roots = await scopeRoots({ home, cwd: project })
    const resolvedProject = await fs.realpath(project)

    expect(roots).toMatchObject({
      home,
      private: path.join(home, 'private'),
      project: resolvedProject,
      projectRoot: resolvedProject,
      team,
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
