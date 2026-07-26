import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  duplicateWorkspaceEntry,
  inspectWorkspaceEntry,
  listWorkspaceDirectory,
  openWorkspaceEntryNative,
  revealWorkspaceEntry,
  renameWorkspaceEntry,
  trashWorkspaceEntries,
} from './workspaceFileOperations.js'

describe('workspace file operations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists a workspace-relative directory through the indexed workspace boundary', async () => {
    invoke.mockResolvedValueOnce([{ path: '/w/docs', relativePath: 'docs', isDirectory: true }])

    await expect(listWorkspaceDirectory('docs')).resolves.toEqual([
      { path: '/w/docs', relativePath: 'docs', isDirectory: true },
    ])
    expect(invoke).toHaveBeenCalledWith('workspace_file_list_directory', { directory: 'docs' })
  })

  it('inspects an entry before choosing an internal or native open path', async () => {
    const entry = { path: '/w/report.pdf', openBehavior: 'pdf', textReadable: false }
    invoke.mockResolvedValueOnce(entry)

    await expect(inspectWorkspaceEntry('/w/report.pdf')).resolves.toEqual(entry)
    expect(invoke).toHaveBeenCalledWith('workspace_file_inspect', { path: '/w/report.pdf' })
  })

  it('creates files and folders without collapsing the operation contract', async () => {
    invoke.mockResolvedValueOnce({ path: '/w/notes.md', relativePath: 'notes.md' })
    invoke.mockResolvedValueOnce({ path: '/w/research', relativePath: 'research' })

    await createWorkspaceFile('notes.md')
    await createWorkspaceFolder('research')

    expect(invoke).toHaveBeenNthCalledWith(1, 'workspace_file_create', {
      relativePath: 'notes.md',
      directory: false,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'workspace_file_create', {
      relativePath: 'research',
      directory: true,
    })
  })

  it('renames, duplicates, trashes, and opens entries with exact path boundaries', async () => {
    invoke.mockResolvedValue({})

    await renameWorkspaceEntry('/w/old.md', 'new.md')
    await duplicateWorkspaceEntry('/w/new.md')
    await trashWorkspaceEntries(['/w/new.md', '/w/archive'])
    await openWorkspaceEntryNative('/w/chart.png')
    await revealWorkspaceEntry('/w/chart.png')

    expect(invoke).toHaveBeenNthCalledWith(1, 'workspace_file_rename', {
      path: '/w/old.md',
      newName: 'new.md',
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'workspace_file_duplicate', { path: '/w/new.md' })
    expect(invoke).toHaveBeenNthCalledWith(3, 'workspace_file_trash', {
      paths: ['/w/new.md', '/w/archive'],
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'workspace_file_open_native', { path: '/w/chart.png' })
    expect(invoke).toHaveBeenNthCalledWith(5, 'workspace_file_reveal', { path: '/w/chart.png' })
  })
})
