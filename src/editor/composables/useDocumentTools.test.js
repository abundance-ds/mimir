import { computed } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useFileStore } from '../../stores/files.js'
import { useDocumentTools } from './useDocumentTools.js'
import { createReviewSession, decideRemaining, moveReviewHistory } from '../reviewSession.js'

const note = 'First line.\r\nShared anchor.\r\n'
let files, tools, onChanged, disk
vi.mock('../../services/fileSystem.js', () => ({
  readFile: vi.fn(async path => disk.get(path)), saveFile: vi.fn(),
  openFileDialog: vi.fn(), saveFileDialog: vi.fn(),
}))
beforeEach(() => {
  files = useFileStore()
  onChanged = vi.fn()
  tools = useDocumentTools({ fileManager: files, currentFile: computed(() => files.currentFile), onChanged })
  disk = new Map([['/X/closed.md', note]])
  invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'document_file_read') return { path: args.path, content: disk.get(args.path), openPaths: [] }
    if (command === 'document_file_write') {
      if (disk.get(args.path) !== args.expectedContent) throw new Error('Document conflict')
      disk.set(args.path, args.content)
      return
    }
  })
})

const add = (target, extra = {}) => tools.mutate('add', { target, anchor_text: 'Shared anchor', text: 'Check this.', ...extra })

async function openPair() {
  await files.openFile('/X/note.md', note, { workspacePath: '/X' })
  const x = files.currentFile
  await files.openFile('/Y/note.md', 'Y text', { workspacePath: '/Y' })
  const y = files.currentFile
  files.setWorkspaceScope('/Y', ['/X', '/Y'])
  return { x, y }
}

describe('document tools across workspaces', () => {
  it('reads a historical snapshot and refuses to mutate its hidden working document', async () => {
    const { x, y } = await openPair()
    const history = useDocumentTools({ fileManager: files, currentFile: computed(() => files.currentFile),
      getReviewState: () => ({ kind: 'history', reviewId: 'snapshot1', path: x.path, content: 'Past text', historyContent: 'Past text' }) })
    expect(await history.state('@editor', true)).toMatchObject({ path: x.path, content: 'Past text', readOnly: true, contentSource: 'history' })
    await expect(history.mutate('add', { target: '@editor', anchor_text: 'Past text', text: 'Comment' })).rejects.toThrow('History is read only')
    expect(x.content).toBe(note)
    expect(y.content).toBe('Y text')
    await history.mutate('add', { target: x.path, anchor_text: 'Shared anchor', text: 'Working file comment' })
    expect(x.content).toContain('Working file comment')
    expect(files.currentFile).toBe(y)
  })
  it('uses the same simple tools on a hidden proposal and preserves its discussion after rejection', async () => {
    const { x, y } = await openPair()
    x.reviewSession = createReviewSession(x.content, 'New proposed passage.\r\n')
    const created = await tools.mutate('add', { target: x.path, anchor_text: 'New proposed passage.', text: 'Verify this.' })
    expect(created).toMatchObject({ contentSource: 'review', status: 'created' })
    expect(x.content).toBe(note)
    expect((await tools.state(x.path, true)).content).toContain('New proposed passage.')
    decideRemaining(x.reviewSession, 'reject')
    await tools.mutate('reply', { target: x.path, comment_id: created.comment_id, text: 'Keep for later.' })
    expect((await tools.comments(x.path)).comments[0]).toMatchObject({ attachment: 'rejected', anchorText: 'New proposed passage.', replies: [{ text: 'Keep for later.' }] })
    moveReviewHistory(x.reviewSession, 'undo')
    const listed = (await tools.comments(x.path)).comments[0]
    expect(listed).toMatchObject({ attachment: 'attached', replies: [{ text: 'Keep for later.' }] })
    expect(listed).not.toHaveProperty('source')
    expect(files.currentFile).toBe(y)
  })

  it('refuses a review whose document prose has changed', async () => {
    const { x } = await openPair()
    x.reviewSession = createReviewSession(x.content, 'Proposal')
    files.updateContent('New user draft', x)
    await expect(tools.mutate('add', { target: x.path, anchor_text: 'Proposal', text: 'Check' })).rejects.toThrow('document text changed')
    expect(x.reviewSession.comments).toEqual([])
  })
  it('reads and changes a hidden dirty buffer without selecting or saving it', async () => {
    const { x, y } = await openPair()
    files.updateContent(`Unsaved.\r\n${note}`, x)
    const snapshot = await tools.state(x.path, true)
    const result = await add(x.path, { expected_revision: snapshot.revision })
    expect(x.content).toContain('Unsaved.\r\n')
    expect(x.content).toContain('<comment')
    expect(x.content).toContain('</comment>.\r\n')
    expect(x.savedContent).toBe(note)
    expect(result).toMatchObject({ documentId: snapshot.documentId, path: x.path, dirty: true, saved: false })
    expect(result.revision).not.toBe(snapshot.revision)
    expect(files.currentFile).toBe(y)
    expect(y.content).toBe('Y text')
    expect(onChanged).toHaveBeenCalledWith(x)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('binds @editor before a workspace switch and can target an untitled document ID', async () => {
    const { x, y } = await openPair()
    files.setWorkspaceScope('/X', ['/X', '/Y'])
    const pending = add('@editor')
    files.setWorkspaceScope('/Y', ['/X', '/Y'])
    await pending
    expect(files.currentFile).toBe(y)
    expect(x.content).toContain('<comment')
    expect(y.content).toBe('Y text')
    files.newFile()
    const draft = files.currentFile
    files.updateContent(note, draft)
    const snapshot = await tools.state('@editor')
    files.setActiveTab(files.openFiles.indexOf(y))
    await add(snapshot.documentId, { expected_revision: snapshot.revision })
    expect(draft.content).toContain('<comment')
    expect(files.currentFile).toBe(y)
  })

  it('lists, replies, and resolves in X while Y stays selected', async () => {
    const { x, y } = await openPair()
    const created = await add(x.path)
    const listed = await tools.comments(x.path)
    expect(listed.comments).toHaveLength(1)
    expect(listed.comments[0]).toMatchObject({ id: created.comment_id, anchorText: 'Shared anchor', line: 2 })
    const replied = await tools.mutate('reply', { target: x.path, comment_id: created.comment_id, text: 'Reply', expected_revision: listed.revision })
    const resolved = await tools.mutate('resolve', { target: x.path, comment_id: created.comment_id, expected_revision: replied.revision })
    expect(resolved.status).toBe('resolved')
    expect((await tools.comments(x.path)).comments[0]).toMatchObject({ status: 'resolved', replies: [{ text: 'Reply' }] })
    expect(files.currentFile).toBe(y)
  })

  it('rejects a stale revision and concurrent edits without changing text', async () => {
    const { x } = await openPair()
    const original = await tools.state(x.path)
    files.updateContent(`New text. ${note}`, x)
    await expect(add(x.path, { expected_revision: original.revision })).rejects.toThrow('conflict')
    const pending = add(x.path)
    files.updateContent(`Newer text. ${note}`, x)
    await expect(pending).rejects.toThrow('conflict')
    expect(x.content).toBe(`Newer text. ${note}`)
  })

  it.each(['close', 'rename'])('rejects a document that changes identity during %s', async action => {
    const { x } = await openPair()
    const pending = add(x.path)
    if (action === 'close') files.closeFile(files.openFiles.indexOf(x))
    else x.path = '/X/renamed.md'
    await expect(pending).rejects.toThrow('conflict')
    expect(x.content).toBe(note)
  })

  it('writes a closed document with a saved-text check and returns a saved receipt', async () => {
    const snapshot = await tools.state('/X/closed.md', true)
    const result = await add('/X/closed.md', { expected_revision: snapshot.revision })
    expect(result).toMatchObject({ path: '/X/closed.md', saved: true, dirty: false })
    expect(disk.get('/X/closed.md')).toContain('<comment')
    expect(files.openFiles).toHaveLength(0)
    expect(invoke).toHaveBeenCalledWith('document_file_write', expect.objectContaining({ expectedContent: note }))
    await expect(add('/X/closed.md', { expected_revision: snapshot.revision })).rejects.toThrow('conflict')
  })

  it('uses a dirty open buffer when the target is a filesystem alias', async () => {
    const { x } = await openPair()
    files.updateContent(`Draft. ${note}`, x)
    invoke.mockResolvedValueOnce({ path: '/canonical/note.md', content: note, openPaths: [x.path] })
    await add('/alias/note.md')
    expect(x.content).toContain('Draft. ')
    expect(x.content).toContain('<comment')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('refuses to overwrite a document opened during a disk read', async () => {
    let finish
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = add('/X/closed.md')
    await files.openFile('/X/closed.md', 'User draft')
    finish({ path: '/X/closed.md', content: note, openPaths: [] })
    await expect(pending).rejects.toThrow('conflict')
    expect(files.currentFile.content).toBe('User draft')
    expect(disk.get('/X/closed.md')).toBe(note)
  })

  it('refreshes a file opened during a checked disk write, including an earlier read', async () => {
    const readVersion = files.documentReadVersion()
    let release, started
    const writing = new Promise(resolve => { started = resolve })
    const normal = invoke.getMockImplementation()
    invoke.mockImplementation(async (command, args) => {
      if (command === 'document_file_write') {
        started()
        await new Promise(resolve => { release = resolve })
      }
      return normal(command, args)
    })
    const pending = add('/X/closed.md')
    await writing
    let opened = false
    const opening = files.openFile('/X/closed.md', note, { readVersion }).then(() => { opened = true })
    await Promise.resolve()
    expect(opened).toBe(false)
    release()
    await Promise.all([pending, opening])
    expect(files.currentFile.content).toContain('<comment')
    expect(files.currentFile.content).toBe(disk.get('/X/closed.md'))
    expect(files.currentFile.dirty).toBe(false)
  })

  it('allows a workspace change that creates an unrelated document during a disk read', async () => {
    let finish
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = add('/X/closed.md')
    files.setWorkspaceScope('/Y', ['/X', '/Y'])
    files.newFile()
    finish({ path: '/X/closed.md', content: note, openPaths: [] })
    await pending
    expect(disk.get('/X/closed.md')).toContain('<comment')
    expect(files.currentFile.path).toBeNull()
  })

  it('retains Graph Details drafts and refuses an ordinary write for an unmounted Graph source', async () => {
    const { x } = await openPair()
    x.kind = 'graph'; x.graph = { version: 1, draft: { title: 'Unsaved title' } }
    expect(await tools.state(x.path, true)).toMatchObject({ kind: 'graph', contentSource: 'saved', graphDraft: { title: 'Unsaved title' } })
    await expect(add(x.path)).rejects.toThrow('Open Source')
    disk.set('/X/graph/entry.md', note)
    await expect(add('/X/graph/entry.md')).rejects.toThrow('not mounted')
    expect(disk.get('/X/graph/entry.md')).toBe(note)
  })

  it('cancels before mutation', async () => {
    const { x } = await openPair()
    const controller = new AbortController()
    const pending = tools.mutate('add', { target: x.path, anchor_text: 'Shared anchor', text: 'Comment' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    expect(x.content).toBe(note)
  })
})
