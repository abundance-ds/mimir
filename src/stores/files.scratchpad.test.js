import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileStore } from './files.js'
import { useScratchpadStore } from './scratchpad.js'
import { saveFile, saveFileDialog } from '../services/fileSystem.js'
import { resolveScratchpad, saveScratchpad, scratchpadSnapshot } from '../services/scratchpad.js'

vi.mock('../services/fileSystem.js', () => ({
  openFileDialog: vi.fn(), saveFileDialog: vi.fn(), saveFile: vi.fn(),
}))
vi.mock('../services/scratchpad.js', () => ({
  resolveScratchpad: vi.fn(), saveScratchpad: vi.fn(), scratchpadSnapshot: vi.fn(),
}))

const path = '/home/.mimir/scratchpad.md'
const alias = '/project/scratchpad.md'
const snapshot = content => ({ path, content, history: [{ time: 1, content }] })

beforeEach(() => {
  vi.resetAllMocks()
  window.__TAURI_INTERNALS__ = {}
  resolveScratchpad.mockImplementation(async value => [path, alias].includes(value) ? path : null)
  scratchpadSnapshot.mockResolvedValue(snapshot('Saved'))
  saveScratchpad.mockImplementation(async content => snapshot(content))
})
afterEach(() => { delete window.__TAURI_INTERNALS__ })

async function openScratchpad() {
  const scratchpad = useScratchpadStore()
  await scratchpad.refresh()
  const files = useFileStore()
  await files.openFile(path, 'Saved')
  return { files, scratchpad }
}

describe('Scratchpad file integration', () => {
  it('deduplicates a project link and retains the dirty global buffer', async () => {
    const { files } = await openScratchpad()
    const id = files.currentFile.id
    files.updateContent('Unsaved text')
    await files.openFile(alias, 'Old disk text', { preview: true })
    files.setWorkspaceScope('/another', ['/home', '/project', '/another'])
    expect(files.openFiles).toHaveLength(1)
    expect(files.currentFile).toMatchObject({ id, path, content: 'Unsaved text', dirty: true, preview: false })
  })

  it('exports a body-only copy without changing the shared tab or its save state', async () => {
    const { files } = await openScratchpad()
    files.updateContent('Draft email')
    saveFileDialog.mockResolvedValue('/project/email.md')
    await files.saveAs()
    expect(saveFile).toHaveBeenCalledWith('/project/email.md', 'Draft email')
    expect(files.currentFile).toMatchObject({ path, content: 'Draft email', dirty: true })
    expect(saveScratchpad).not.toHaveBeenCalled()
  })

  it('saves through the shared authority when Save As selects a project alias', async () => {
    const { files } = await openScratchpad()
    files.updateContent('Draft email')
    saveFileDialog.mockResolvedValue(alias)
    await files.saveAs()
    expect(saveFile).not.toHaveBeenCalled()
    expect(saveScratchpad).toHaveBeenCalledWith('Draft email', 'Saved')
    expect(files.currentFile).toMatchObject({ path, content: 'Draft email', dirty: false })
  })

  it('retains a dirty buffer and its base when the shared save fails', async () => {
    const { files } = await openScratchpad()
    files.updateContent('Human text')
    saveScratchpad.mockRejectedValueOnce(new Error('Disk full'))
    await expect(files.save()).rejects.toThrow('Disk full')
    expect(files.currentFile).toMatchObject({ content: 'Human text', dirty: true, scratchpadBase: 'Saved', saveState: 'failed' })
  })
})
