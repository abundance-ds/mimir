import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addSkill,
  findSkill,
  listSkills,
  materializeClaudeSnapshot,
  prepareSkills,
  refreshNativeSkills,
} from '../../bin/mimir-skills.mjs'

describe('mimir skills', () => {
  let root
  let home
  let project
  let nativeRoot
  let teamRoot

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-skills-'))
    home = path.join(root, 'home')
    project = path.join(root, 'project')
    nativeRoot = path.join(root, 'native')
    teamRoot = path.join(home, 'team-graph')
    await Promise.all([
      fs.mkdir(project, { recursive: true }),
      fs.mkdir(path.join(teamRoot, 'graph'), { recursive: true }),
      fs.mkdir(path.join(teamRoot, 'resources'), { recursive: true }),
    ])
    await fs.writeFile(path.join(teamRoot, 'mimir-team.toml'), 'version = 1\nname = "Test"\n')
    execFileSync('git', ['init', teamRoot])
    execFileSync('git', ['-C', teamRoot, 'remote', 'add', 'origin', 'https://github.com/test/team-graph.git'])
  })

  afterEach(async () => {
    await makeWritable(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stores team, private, and project skills in their scope roots', async () => {
    const team = await sourceSkill(root, 'release-review', 'Review a release before publishing.')
    const privateSkill = await sourceSkill(root, 'writing-style', 'Apply my personal writing style.')
    const projectSkill = await sourceSkill(root, 'deploy-api', 'Deploy this project API.')
    const options = { home, cwd: project, nativeRoot }

    await addSkill(team, 'team', options)
    await addSkill(privateSkill, 'private', options)
    await addSkill(projectSkill, 'project', options)

    await expect(listSkills(options)).resolves.toMatchObject([
      { name: 'deploy-api', scope: 'project' },
      { name: 'release-review', scope: 'team' },
      { name: 'writing-style', scope: 'private' },
    ])
    await expect(fs.realpath(path.join(nativeRoot, 'release-review')))
      .resolves.toContain(path.join('skills', 'revisions', 'team', 'release-review'))
    await expect(fs.realpath(path.join(nativeRoot, 'writing-style')))
      .resolves.toContain(path.join('skills', 'revisions', 'private', 'writing-style'))
    await expect(fs.lstat(path.join(nativeRoot, 'deploy-api'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('uses only the fixed valid Team repository', async () => {
    const sharedTeam = path.join(root, 'shared-team')
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    await fs.mkdir(sharedTeam, { recursive: true })
    await fs.writeFile(
      path.join(home, 'settings.json'),
      `${JSON.stringify({ editor: { mimirTeamFolder: sharedTeam } }, null, 2)}\n`,
    )

    await addSkill(release, 'team', { home, cwd: project, nativeRoot })

    await expect(fs.readFile(
      path.join(teamRoot, 'skills', 'release-review', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('name: release-review')
    await expect(fs.lstat(path.join(sharedTeam, 'skills', 'release-review')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(path.join(home, 'skills', 'catalog', 'release-review')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parses folded descriptions through the shared package frontmatter reader', async () => {
    const directory = path.join(project, 'skills/evidence-review')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---
name: evidence-review
description: >-
  Review evidence tables
  before delivery.
---
# Evidence review
`)

    await expect(listSkills({ home, cwd: project, nativeRoot }))
      .resolves.toMatchObject([
        { name: 'evidence-review', description: 'Review evidence tables before delivery.' },
      ])
  })

  it('accepts standard nested skill metadata', async () => {
    const directory = path.join(project, 'skills/evidence-review')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---
name: evidence-review
description: Review evidence before delivery.
metadata:
  owner: evidence-team
  version: 1
---
# Evidence review
`)

    await expect(listSkills({ home, cwd: project, nativeRoot }))
      .resolves.toMatchObject([
        { name: 'evidence-review', description: 'Review evidence before delivery.' },
      ])
  })

  it('skips a malformed higher-precedence skill and prepares the valid lower copy', async () => {
    const options = { home, cwd: project, nativeRoot }
    const privateSkill = await sourceSkill(root, 'release-review', 'Private release review.')
    await addSkill(privateSkill, 'private', options)
    const broken = path.join(project, 'skills/release-review')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'SKILL.md'), '---\nname: release-review\n')
    const diagnostics = []

    const prepared = await prepareSkills('codex', { ...options, diagnostics })
    const skills = await listSkills(options)

    expect(skills).toMatchObject([{ name: 'release-review', scope: 'private' }])
    expect(prepared.nativeSkills).toBe(1)
    expect(prepared.diagnostics).toEqual([
      expect.stringContaining('project/skills/release-review: SKILL.md frontmatter is not closed'),
    ])
    await expect(fs.realpath(path.join(nativeRoot, 'release-review')))
      .resolves.toContain(path.join('revisions', 'private', 'release-review'))
  })

  it('reports an oversized skill source without loading it into the catalog', async () => {
    const directory = path.join(project, 'skills/oversized')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: oversized\ndescription: Too large.\n---\n${'x'.repeat(512 * 1024)}`,
    )
    const diagnostics = []

    const skills = await listSkills({ home, cwd: project, nativeRoot, diagnostics })

    expect(skills).toEqual([])
    expect(diagnostics).toEqual([
      expect.stringContaining('SKILL.md exceeds the 512 KB prompt payload limit'),
    ])
  })

  it('lists one skill when Project and Team are the same physical root', async () => {
    const source = await sourceSkill(root, 'evidence-review', 'Review the evidence.')
    await addSkill(source, 'project', { home, cwd: project, nativeRoot, teamRoot: project })

    await expect(listSkills({ home, cwd: project, nativeRoot, teamRoot: project }))
      .resolves.toMatchObject([
        { name: 'evidence-review', scope: 'project' },
      ])
  })

  it('does not use a legacy Team root option during install', async () => {
    const missingTeam = path.join(root, 'missing-team')
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    await fs.rm(teamRoot, { recursive: true, force: true })

    await expect(addSkill(release, 'team', {
      home,
      cwd: project,
      nativeRoot,
      teamRoot: missingTeam,
    })).rejects.toThrow('The team scope is not mounted.')
    await expect(fs.lstat(missingTeam)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('matches by exact name or task description without an AI request', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review this release before publishing.')
    const notes = await sourceSkill(
      path.join(root, 'notes'),
      'release-notes',
      'Write publication notes.',
    )
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'private', options)
    await addSkill(notes, 'private', options)

    await expect(findSkill('release-review', options)).resolves.toMatchObject({
      skill: {
        name: 'release-review',
        path: expect.stringContaining(path.join('revisions', 'private', 'release-review')),
      },
    })
    await expect(findSkill('please review this release', options)).resolves.toMatchObject({
      skill: { name: 'release-review' },
    })
  })

  it('matches the packaged graph skill for knowledge tasks', async () => {
    const options = {
      home,
      cwd: path.resolve('.'),
      nativeRoot,
    }

    const found = await findSkill('knowledge', options)

    expect(found).toMatchObject({
      skill: {
        name: 'mimir-graph',
        description: 'Use the Mimir knowledge graph, Team resources, scopes, and history.',
      },
    })
    await expect(fs.readFile(
      path.join(found.skill.path, 'references', 'graph.md'),
      'utf8',
    )).resolves.toContain('## Fast path')
  })

  it('preserves packaged graph references in native and Claude projections', async () => {
    await fs.mkdir(path.join(teamRoot, 'skills'), { recursive: true })
    await fs.cp(
      path.resolve('skills/mimir-graph'),
      path.join(teamRoot, 'skills/mimir-graph'),
      { recursive: true },
    )
    const options = {
      home,
      cwd: project,
      nativeRoot,
    }

    const prepared = await prepareSkills('claude', options)
    const nativeReference = path.join(
      nativeRoot,
      'mimir-graph',
      'references',
      'graph.md',
    )
    const claudeReference = path.join(
      prepared.claudeRoot,
      '.claude',
      'skills',
      'mimir-graph',
      'references',
      'graph.md',
    )

    await expect(fs.readFile(nativeReference, 'utf8'))
      .resolves.toContain('## Ontology')
    await expect(fs.readFile(nativeReference, 'utf8'))
      .resolves.toContain('graph_resource_add')
    await expect(fs.readFile(claudeReference, 'utf8'))
      .resolves.toContain('## Ontology')
  })

  it('uses Private to shadow a Team skill with the same name', async () => {
    const first = await sourceSkill(path.join(root, 'one'), 'release-review', 'Team release review.')
    const second = await sourceSkill(path.join(root, 'two'), 'release-review', 'Private release review.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(first, 'team', options)
    await addSkill(second, 'private', options)

    await expect(listSkills(options)).resolves.toMatchObject([
      { name: 'release-review', scope: 'private' },
    ])
  })

  it('allows the same project skill name in projects that are never visible together', async () => {
    const firstProject = path.join(root, 'project-one')
    const secondProject = path.join(root, 'project-two')
    const first = await sourceSkill(path.join(root, 'one'), 'deploy', 'Deploy project one.')
    const second = await sourceSkill(path.join(root, 'two'), 'deploy', 'Deploy project two.')
    await fs.mkdir(firstProject, { recursive: true })
    await fs.mkdir(secondProject, { recursive: true })

    await expect(addSkill(first, 'project', {
      home,
      cwd: firstProject,
      nativeRoot,
    })).resolves.toMatchObject({ name: 'deploy' })
    await expect(addSkill(second, 'project', {
      home,
      cwd: secondProject,
      nativeRoot,
    })).resolves.toMatchObject({ name: 'deploy' })
  })

  it('does not overwrite unrelated native skills', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const options = { home, cwd: project, nativeRoot }
    await fs.mkdir(path.join(nativeRoot, 'release-review'), { recursive: true })

    await expect(addSkill(release, 'private', options)).rejects.toThrow(
      'already exists and is not managed by Mimir',
    )
    await expect(fs.lstat(path.join(home, 'private', 'skills', 'release-review')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('repairs a stale link into Mimir revision storage', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'private', options)
    const link = path.join(nativeRoot, 'release-review')
    const stale = path.join(
      home,
      'skills',
      'revisions',
      'catalog',
      'release-review',
      'a'.repeat(64),
    )
    await fs.mkdir(stale, { recursive: true })
    await fs.unlink(link)
    await fs.symlink(stale, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(refreshNativeSkills(options)).resolves.toMatchObject({ count: 1 })
    await expect(fs.realpath(link))
      .resolves.toContain(path.join('revisions', 'private', 'release-review'))
  })

  it('materializes a Claude snapshot with all visible skill packages', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const deploy = await sourceSkill(root, 'deploy-api', 'Deploy this API.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'private', options)
    await addSkill(deploy, 'project', options)

    const snapshot = path.join(home, 'skills', 'snapshots', 'claude', 'test-project')
    await expect(materializeClaudeSnapshot(snapshot, options)).resolves.toEqual({
      root: snapshot,
      count: 2,
    })
    await expect(fs.realpath(path.join(snapshot, '.claude', 'skills', 'release-review')))
      .resolves.toContain(path.join('skills', 'revisions', 'private', 'release-review'))
    await expect(fs.realpath(path.join(snapshot, '.claude', 'skills', 'deploy-api')))
      .resolves.toContain(path.join('skills', 'revisions', 'project'))
    const mode = (await fs.stat(
      path.join(snapshot, '.claude', 'skills', 'release-review', 'SKILL.md'),
    )).mode
    expect(mode & 0o222).toBe(0)
  })

  it('passes Pi immutable project skill files instead of canonical storage', async () => {
    const deploy = await sourceSkill(root, 'deploy-api', 'Deploy this API.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(deploy, 'project', options)

    const prepared = await prepareSkills('pi', options)
    expect(prepared.projectSkillFiles).toHaveLength(1)
    expect(prepared.projectSkillFiles[0]).toContain(path.join('skills', 'revisions', 'project'))
    expect(prepared.projectSkillFiles[0]).toMatch(/SKILL\.md$/)
  })

  it('retains each project-skill revision when the canonical package changes', async () => {
    const first = await sourceSkill(path.join(root, 'one'), 'deploy-api', 'Deploy version one.')
    const second = await sourceSkill(path.join(root, 'two'), 'deploy-api', 'Deploy version two.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(first, 'project', options)
    await addSkill(second, 'project', options)

    const revisions = await fs.readdir(
      path.join(home, 'skills', 'revisions', 'project', 'deploy-api'),
    )
    expect(revisions).toHaveLength(2)
  })

  it('rejects package symlinks that escape the skill revision', async () => {
    if (process.platform === 'win32') return
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    await fs.symlink(
      path.join(root, 'outside.txt'),
      path.join(release, 'scripts', 'outside.txt'),
    )
    await fs.writeFile(path.join(root, 'outside.txt'), 'mutable')

    await expect(addSkill(release, 'private', {
      home,
      cwd: project,
      nativeRoot,
    })).rejects.toThrow('Skill symlink escapes its package')
  })

  it('refuses a materialized revision whose content was modified', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'private', options)
    const found = await findSkill('release-review', options)
    const skillFile = path.join(found.skill.path, 'SKILL.md')
    await fs.chmod(skillFile, 0o600)
    await fs.appendFile(skillFile, '\nmodified\n')

    await expect(findSkill('release-review', options))
      .rejects.toThrow('Skill revision content was modified')
  })

  it('refreshes only links recorded in Mimir projection state', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'private', options)
    await fs.rm(path.join(home, 'private', 'skills', 'release-review'), {
      recursive: true,
      force: true,
    })

    await expect(refreshNativeSkills(options)).resolves.toMatchObject({ count: 0 })
    await expect(fs.lstat(path.join(nativeRoot, 'release-review'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects projection entries outside the configured native root', async () => {
    const outside = path.join(root, 'outside-link')
    const outsideTarget = path.join(root, 'outside-target')
    await fs.mkdir(outsideTarget, { recursive: true })
    await fs.symlink(outsideTarget, outside)
    await fs.mkdir(path.join(home, 'skills'), { recursive: true })
    await fs.writeFile(
      path.join(home, 'skills', 'native-projection.json'),
      `${JSON.stringify({
        version: 1,
        entries: [{
          name: 'outside-link',
          path: outside,
          target: outsideTarget,
        }],
      })}\n`,
    )

    await expect(refreshNativeSkills({ home, cwd: project, nativeRoot }))
      .rejects.toThrow('Invalid Mimir native skill projection entry')
    await expect(fs.lstat(outside)).resolves.toMatchObject({})
  })

})

async function sourceSkill(parent, name, description) {
  const directory = path.join(parent, 'sources', name)
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true })
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
  await fs.writeFile(path.join(directory, 'scripts', 'run.sh'), '#!/bin/sh\n')
  return directory
}

async function makeWritable(target) {
  let metadata
  try {
    metadata = await fs.lstat(target)
  } catch {
    return
  }
  if (metadata.isSymbolicLink()) return
  await fs.chmod(target, metadata.mode | 0o700)
  if (metadata.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await makeWritable(path.join(target, entry))
    }
  }
}
