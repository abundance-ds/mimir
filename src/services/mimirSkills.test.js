import { promises as fs } from 'node:fs'
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

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mimir-skills-'))
    home = path.join(root, 'home')
    project = path.join(root, 'project')
    nativeRoot = path.join(root, 'native')
    await fs.mkdir(project, { recursive: true })
  })

  afterEach(async () => {
    await makeWritable(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stores catalog, personal, and project skills without project cloning', async () => {
    const catalog = await sourceSkill(root, 'release-review', 'Review a release before publishing.')
    const personal = await sourceSkill(root, 'writing-style', 'Apply my personal writing style.')
    const projectSkill = await sourceSkill(root, 'deploy-api', 'Deploy this project API.')
    const options = { home, cwd: project, nativeRoot }

    await addSkill(catalog, 'catalog', options)
    await addSkill(personal, 'personal', options)
    await addSkill(projectSkill, 'project', options)

    await expect(listSkills(options)).resolves.toMatchObject([
      { name: 'deploy-api', scope: 'project' },
      { name: 'release-review', scope: 'catalog' },
      { name: 'writing-style', scope: 'personal' },
    ])
    await expect(fs.realpath(path.join(nativeRoot, 'release-review')))
      .resolves.toContain(path.join('skills', 'revisions', 'catalog', 'release-review'))
    await expect(fs.realpath(path.join(nativeRoot, 'writing-style')))
      .resolves.toContain(path.join('skills', 'revisions', 'personal', 'writing-style'))
    await expect(fs.lstat(path.join(nativeRoot, 'deploy-api'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('uses the shared catalog root configured in settings', async () => {
    const sharedCatalog = path.join(root, 'shared-team-catalog')
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      path.join(home, 'settings.json'),
      `${JSON.stringify({ skills: { catalogRoot: sharedCatalog } }, null, 2)}\n`,
    )

    await addSkill(release, 'catalog', { home, cwd: project, nativeRoot })

    await expect(fs.readFile(
      path.join(sharedCatalog, 'release-review', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('name: release-review')
    await expect(fs.lstat(path.join(home, 'skills', 'catalog', 'release-review')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an ambiguous relative shared catalog root', async () => {
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      path.join(home, 'settings.json'),
      '{"skills":{"catalogRoot":"../shared"}}\n',
    )

    await expect(listSkills({ home, cwd: project, nativeRoot }))
      .rejects.toThrow('settings.skills.catalogRoot must be an absolute path')
  })

  it('matches by exact name or task description without an AI request', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review this release before publishing.')
    const notes = await sourceSkill(
      path.join(root, 'notes'),
      'release-notes',
      'Write publication notes.',
    )
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'catalog', options)
    await addSkill(notes, 'catalog', options)

    await expect(findSkill('release-review', options)).resolves.toMatchObject({
      skill: {
        name: 'release-review',
        path: expect.stringContaining(path.join('revisions', 'catalog', 'release-review')),
      },
    })
    await expect(findSkill('please review this release', options)).resolves.toMatchObject({
      skill: { name: 'release-review' },
    })
  })

  it('matches the packaged graph skill for knowledge tasks', async () => {
    const options = {
      home,
      cwd: project,
      nativeRoot,
      catalogRoot: path.resolve('skills'),
    }

    const found = await findSkill('knowledge', options)

    expect(found).toMatchObject({
      skill: {
        name: 'mimir-graph',
        description: 'Mimir knowledge graph.',
      },
    })
    await expect(fs.readFile(
      path.join(found.skill.path, 'references', 'graph.md'),
      'utf8',
    )).resolves.toContain('## Fast path')
  })

  it('preserves packaged graph references in native and Claude projections', async () => {
    const options = {
      home,
      cwd: project,
      nativeRoot,
      catalogRoot: path.resolve('skills'),
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
    await expect(fs.readFile(claudeReference, 'utf8'))
      .resolves.toContain('## Ontology')
  })

  it('rejects duplicate names across visible scopes', async () => {
    const first = await sourceSkill(path.join(root, 'one'), 'release-review', 'Team release review.')
    const second = await sourceSkill(path.join(root, 'two'), 'release-review', 'Private release review.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(first, 'catalog', options)

    await expect(addSkill(second, 'personal', options)).rejects.toThrow(
      "Skill 'release-review' already exists in catalog",
    )
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

    await expect(addSkill(release, 'catalog', options)).rejects.toThrow(
      'already exists and is not managed by Mimir',
    )
    await expect(fs.lstat(path.join(home, 'skills', 'catalog', 'release-review')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('materializes a Claude snapshot with all visible skill packages', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const deploy = await sourceSkill(root, 'deploy-api', 'Deploy this API.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'catalog', options)
    await addSkill(deploy, 'project', options)

    const snapshot = path.join(home, 'skills', 'snapshots', 'claude', 'test-project')
    await expect(materializeClaudeSnapshot(snapshot, options)).resolves.toEqual({
      root: snapshot,
      count: 2,
    })
    await expect(fs.realpath(path.join(snapshot, '.claude', 'skills', 'release-review')))
      .resolves.toContain(path.join('skills', 'revisions', 'catalog', 'release-review'))
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

    await expect(addSkill(release, 'catalog', {
      home,
      cwd: project,
      nativeRoot,
    })).rejects.toThrow('Skill symlink escapes its package')
  })

  it('refuses a materialized revision whose content was modified', async () => {
    const release = await sourceSkill(root, 'release-review', 'Review a release.')
    const options = { home, cwd: project, nativeRoot }
    await addSkill(release, 'catalog', options)
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
    await addSkill(release, 'catalog', options)
    await fs.rm(path.join(home, 'skills', 'catalog', 'release-review'), {
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
