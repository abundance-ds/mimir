import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addAgent, listAgents } from '../../bin/mimir-agents.mjs'

describe('mimir agent packages', () => {
  let root
  let home
  let project
  let team

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-agents-'))
    home = path.join(root, 'home')
    project = path.join(root, 'project')
    team = path.join(root, 'team')
    await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(team, { recursive: true })])
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('installs packages into scope roots and reports visible overrides', async () => {
    const options = { home, cwd: project, teamRoot: team }
    const teamSource = await sourceAgent(path.join(root, 'team-source'), 'review', 'Team review')
    const privateSource = await sourceAgent(path.join(root, 'private-source'), 'review', 'Private review')
    const projectSource = await sourceAgent(path.join(root, 'project-source'), 'review', 'Project review')

    await addAgent(teamSource, 'team', options)
    await addAgent(privateSource, 'private', options)
    await addAgent(projectSource, 'project', options)

    const agents = await listAgents(options)
    expect(agents).toMatchObject([
      { name: 'review', scope: 'project', active: true, title: 'Project review' },
      { name: 'review', scope: 'private', active: false, shadowedBy: 'project' },
      { name: 'review', scope: 'team', active: false, shadowedBy: 'project' },
    ])
    await expect(fs.readFile(path.join(project, 'agents/review/AGENT.md'), 'utf8'))
      .resolves.toContain('Project mission')
    await expect(fs.readFile(path.join(home, 'private/agents/review/AGENT.md'), 'utf8'))
      .resolves.toContain('Private mission')
    await expect(fs.readFile(path.join(team, 'agents/review/AGENT.md'), 'utf8'))
      .resolves.toContain('Team mission')
  })

  it('keeps valid packages visible when one package is malformed', async () => {
    const options = { home, cwd: project, teamRoot: team }
    const privateSource = await sourceAgent(path.join(root, 'private-source'), 'review', 'Private review')
    await addAgent(privateSource, 'private', options)
    await fs.mkdir(path.join(project, 'agents/review'), { recursive: true })
    await fs.writeFile(path.join(project, 'agents/review/AGENT.md'), '---\ntitle: Broken\n')

    const agents = await listAgents(options)

    expect(agents).toMatchObject([
      {
        name: 'review',
        scope: 'project',
        active: false,
        diagnostic: 'AGENT.md frontmatter is not closed',
      },
      { name: 'review', scope: 'private', active: true },
    ])
  })

  it('does not let an empty mission hide a valid lower-precedence package', async () => {
    const options = { home, cwd: project, teamRoot: team }
    const privateSource = await sourceAgent(path.join(root, 'private-source'), 'review', 'Private review')
    await addAgent(privateSource, 'private', options)
    await fs.mkdir(path.join(project, 'agents/review'), { recursive: true })
    await fs.writeFile(
      path.join(project, 'agents/review/AGENT.md'),
      '---\ntitle: Empty\n---\n\n',
    )

    const agents = await listAgents(options)

    expect(agents).toMatchObject([
      {
        name: 'review',
        scope: 'project',
        active: false,
        diagnostic: 'AGENT.md mission must not be empty',
      },
      { name: 'review', scope: 'private', active: true },
    ])
  })

  it('reports an oversized agent source without loading it into the listing', async () => {
    const directory = path.join(project, 'agents/oversized')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'AGENT.md'),
      Buffer.alloc((512 * 1024) + 1, 'x'),
    )

    const agents = await listAgents({ home, cwd: project, teamRoot: team })

    expect(agents).toMatchObject([{
      name: 'oversized',
      active: false,
      diagnostic: 'AGENT.md exceeds the 512 KB prompt payload limit',
    }])
  })

  it('does not recreate a missing Team folder during install', async () => {
    const missingTeam = path.join(root, 'missing-team')
    const source = await sourceAgent(path.join(root, 'source'), 'review', 'Team review')

    await expect(addAgent(source, 'team', {
      home,
      cwd: project,
      teamRoot: missingTeam,
    })).rejects.toThrow(`The Team folder does not exist: ${missingTeam}`)
    await expect(fs.lstat(missingTeam)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parses block scalars and string lists with the same package schema as native runs', async () => {
    const directory = path.join(project, 'agents/evidence')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'AGENT.md'), `---
title: Evidence sweep
description: >-
  Review the evidence
  with care.
args: [--model, "gpt-5"]
skills:
  - search
  - graph
interactive: true
---
Do the work.
`)

    const [agent] = await listAgents({ home, cwd: project, teamRoot: team })

    expect(agent).toMatchObject({
      name: 'evidence',
      title: 'Evidence sweep',
      description: 'Review the evidence with care.',
      args: ['--model', 'gpt-5'],
      skills: ['search', 'graph'],
      interactive: true,
      active: true,
    })
  })

  it('preserves a hash character inside a quoted frontmatter value', async () => {
    const directory = path.join(project, 'agents/review')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'AGENT.md'),
      '---\ntitle: "Review #1" # display title\n---\nReview the work.\n',
    )

    const [agent] = await listAgents({ home, cwd: project, teamRoot: team })

    expect(agent.title).toBe('Review #1')
  })

  it('reports missing files and bad folder names without hiding valid packages', async () => {
    const options = { home, cwd: project, teamRoot: team }
    await sourceAgent(path.join(home, 'private/agents'), 'review', 'Private review')
    await fs.mkdir(path.join(project, 'agents/empty'), { recursive: true })
    await fs.mkdir(path.join(project, 'agents/Bad_Name'), { recursive: true })
    await fs.writeFile(path.join(project, 'agents/Bad_Name/AGENT.md'), 'Mission.\n')

    const agents = await listAgents(options)

    expect(agents.find(agent => agent.name === 'review')).toMatchObject({ active: true })
    expect(agents.find(agent => agent.name === 'empty')).toMatchObject({
      active: false,
      diagnostic: expect.stringContaining('AGENT.md'),
    })
    expect(agents.find(agent => agent.name === 'Bad_Name')).toMatchObject({
      active: false,
      diagnostic: expect.stringContaining('lowercase letters'),
    })
  })

  it('lists one package when Project and Team are the same physical root', async () => {
    await sourceAgent(path.join(project, 'agents'), 'review', 'Project review')

    const agents = await listAgents({ home, cwd: project, teamRoot: project })

    expect(agents).toMatchObject([
      { name: 'review', scope: 'project', active: true },
    ])
  })
})

async function sourceAgent(parent, name, title) {
  const directory = path.join(parent, name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'AGENT.md'),
    `---\ntitle: ${title}\ndescription: Useful mission.\n---\n${title.split(' ')[0]} mission.\n`,
  )
  return directory
}
