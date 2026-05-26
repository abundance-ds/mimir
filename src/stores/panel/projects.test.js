import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../services/dataDir', () => ({
  writeShoulderMarker: vi.fn(() => Promise.resolve()),
  readShoulderMarker: vi.fn(() => Promise.resolve(null)),
  deleteShoulderMarker: vi.fn(() => Promise.resolve()),
  deleteProjectDir: vi.fn(() => Promise.resolve()),
  indexProjectFiles: vi.fn(() => Promise.resolve([])),
}))

import { useProjectStore } from './projects.js'

describe('project store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initializes with default general project', () => {
    const store = useProjectStore()
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].id).toBe('general')
    expect(store.projects[0].system).toBe(true)
    expect(store.expandedProjectIds).toEqual([])
    expect(store.projectFileIndex).toEqual([])
  })

  it('expandProject adds to expandedProjectIds', () => {
    const store = useProjectStore()
    store.expandProject('general')
    expect(store.expandedProjectIds).toContain('general')
  })

  it('expandProject does not duplicate ids', () => {
    const store = useProjectStore()
    store.expandProject('general')
    store.expandProject('general')
    expect(store.expandedProjectIds.filter(id => id === 'general')).toHaveLength(1)
  })

  it('toggleProject adds when not present', () => {
    const store = useProjectStore()
    store.toggleProject('general')
    expect(store.expandedProjectIds).toContain('general')
  })

  it('toggleProject removes when present', () => {
    const store = useProjectStore()
    store.expandProject('general')
    store.toggleProject('general')
    expect(store.expandedProjectIds).not.toContain('general')
  })

  it('projectExpanded returns correct boolean', () => {
    const store = useProjectStore()
    expect(store.projectExpanded('general')).toBe(false)
    store.expandProject('general')
    expect(store.projectExpanded('general')).toBe(true)
  })

  it('collapseAllProjects clears all', () => {
    const store = useProjectStore()
    store.expandProject('general')
    store.expandProject('proj1')
    store.collapseAllProjects()
    expect(store.expandedProjectIds).toEqual([])
  })

  it('resolveProjectPath returns path for known project with absolute path', () => {
    const store = useProjectStore()
    store.projects.push({
      id: 'proj1',
      name: 'Test',
      workspacePath: '/home/user/project',
      path: '/home/user/project',
      system: false,
    })
    expect(store.resolveProjectPath('proj1')).toBe('/home/user/project')
  })

  it('resolveProjectPath returns null for unknown project', () => {
    const store = useProjectStore()
    expect(store.resolveProjectPath('nonexistent')).toBe(null)
  })

  it('resolveProjectPath returns null for project without absolute path', () => {
    const store = useProjectStore()
    // The general project has path "Panel-wide chats" which is not absolute
    expect(store.resolveProjectPath('general')).toBe(null)
  })

  it('linkFolderAsProject creates project with correct shape', async () => {
    const store = useProjectStore()
    const project = await store.linkFolderAsProject({ name: 'My Project', workspacePath: null })
    expect(project).toBeDefined()
    expect(project.name).toBe('My Project')
    expect(project.system).toBe(false)
    expect(project.id).toMatch(/^project_/)
    expect(store.projects).toHaveLength(2)
    expect(store.expandedProjectIds).toContain(project.id)
  })

  it('linkFolderAsProject returns existing project if workspace already linked', async () => {
    const store = useProjectStore()
    const first = await store.linkFolderAsProject({ name: 'Proj', workspacePath: '/tmp/test' })
    const second = await store.linkFolderAsProject({ name: 'Proj2', workspacePath: '/tmp/test' })
    expect(second.id).toBe(first.id)
    expect(store.projects).toHaveLength(2) // general + first
  })

  it('renameProject updates name', async () => {
    const store = useProjectStore()
    const project = await store.linkFolderAsProject({ name: 'Old Name', workspacePath: null })
    await store.renameProject(project.id, 'New Name')
    expect(store.projects.find(p => p.id === project.id).name).toBe('New Name')
  })

  it('renameProject does not rename general project', async () => {
    const store = useProjectStore()
    await store.renameProject('general', 'Renamed')
    expect(store.projects[0].name).toBe('Personal')
  })

  it('renameProject does not rename with empty name', async () => {
    const store = useProjectStore()
    const project = await store.linkFolderAsProject({ name: 'Keep Me', workspacePath: null })
    await store.renameProject(project.id, '   ')
    expect(store.projects.find(p => p.id === project.id).name).toBe('Keep Me')
  })

  it('removeProject removes project from list', async () => {
    const store = useProjectStore()
    const project = await store.linkFolderAsProject({ name: 'Remove Me', workspacePath: null })
    expect(store.projects).toHaveLength(2)
    await store.removeProject(project.id)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].id).toBe('general')
  })

  it('removeProject does not remove general project', async () => {
    const store = useProjectStore()
    await store.removeProject('general')
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].id).toBe('general')
  })

  it('insertProject places after general', () => {
    const store = useProjectStore()
    const newProj = { id: 'proj1', name: 'P1', system: false }
    store.insertProject(newProj)
    expect(store.projects[0].id).toBe('general')
    expect(store.projects[1].id).toBe('proj1')
  })

  it('insertProject places multiple projects in insertion order after general', () => {
    const store = useProjectStore()
    store.insertProject({ id: 'a', name: 'A', system: false })
    store.insertProject({ id: 'b', name: 'B', system: false })
    expect(store.projects[0].id).toBe('general')
    expect(store.projects[1].id).toBe('b')
    expect(store.projects[2].id).toBe('a')
  })

  it('orderProjects keeps general first', () => {
    const store = useProjectStore()
    const list = [
      { id: 'proj1', name: 'P1' },
      { id: 'general', name: 'General' },
      { id: 'proj2', name: 'P2' },
    ]
    const result = store.orderProjects(list)
    expect(result[0].id).toBe('general')
  })

  it('orderProjects respects order array', () => {
    const store = useProjectStore()
    const list = [
      { id: 'general', name: 'General' },
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]
    const result = store.orderProjects(list, ['c', 'a', 'b'])
    expect(result.map(p => p.id)).toEqual(['general', 'c', 'a', 'b'])
  })

  it('mergeProjects merges saved with defaults', () => {
    const store = useProjectStore()
    const saved = [
      { id: 'proj1', name: 'Saved Project' },
    ]
    const result = store.mergeProjects(saved)
    const ids = result.map(p => p.id)
    expect(ids).toContain('general')
    expect(ids).toContain('proj1')
  })

  it('mergeProjects skips invalid entries', () => {
    const store = useProjectStore()
    const saved = [
      null,
      { id: '', name: 'No ID' },
      { id: 'valid', name: 'Valid' },
    ]
    const result = store.mergeProjects(saved)
    const ids = result.map(p => p.id)
    expect(ids).toContain('general')
    expect(ids).toContain('valid')
    expect(ids).not.toContain('')
  })

  it('checkFolderForExistingProject finds by path', async () => {
    const store = useProjectStore()
    await store.linkFolderAsProject({ name: 'Linked', workspacePath: '/tmp/linked' })
    const found = await store.checkFolderForExistingProject('/tmp/linked')
    expect(found).not.toBeNull()
    expect(found.name).toBe('Linked')
  })

  it('checkFolderForExistingProject returns null for unknown path', async () => {
    const store = useProjectStore()
    const found = await store.checkFolderForExistingProject('/tmp/unknown')
    expect(found).toBeNull()
  })
})
