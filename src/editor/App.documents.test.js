import { nextTick } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { acceptChunk, rejectChunk, getChunks } from '@codemirror/merge'
import { undo, redo } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import App from './App.vue'
import EditorSurface from './components/workspace/EditorSurface.vue'
import DiffBar from './components/workspace/DiffBar.vue'
import { useFileStore } from '../stores/files.js'
import { useSettingsStore } from '../stores/settings.js'
import { useDiffStore } from '../stores/diff.js'
import { createSessionSnapshot } from './sessionPersist.js'
import { parseCommentTags, stripCommentTags } from '../services/comments/parser.js'

const io = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }))
vi.mock('../services/session.js', () => ({ loadSession: vi.fn(async () => null), saveSession: vi.fn(async () => {}) }))
vi.mock('../services/fileSystem.js', () => ({ readFile: io.read, saveFile: io.save, openFileDialog: vi.fn(), saveFileDialog: vi.fn(), openHtmlInBrowser: vi.fn(), readBinaryFile: vi.fn() }))
vi.mock('./nativeMenu.js', () => ({ installNativeEditorMenu: vi.fn(async () => true), shouldInstallNativeEditorMenu: () => false }))
enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())
beforeEach(() => {
  io.read.mockReset().mockImplementation(async path => `Text of ${path}\n`)
  io.save.mockReset().mockResolvedValue(undefined)
  useSettingsStore().editorAutoSave = false
})

async function setup() {
  const files = useFileStore()
  const wrapper = mount(App, {
    props: { embedded: true, workspacePath: '/work', workspacePaths: ['/work'] },
    global: { stubs: { AppHeader: true, AppFooter: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true, Teleport: true, Transition: false } },
  })
  await flushPromises()
  const surface = wrapper.findComponent(EditorSurface)
  const open = (path, preview = false) => wrapper.vm.mimirOpen(path, { preview, entry: { openBehavior: 'text' } })
  const type = text => surface.vm.getView().dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' })
  return { files, wrapper, surface, open, type }
}

describe('document lifecycle with the real editor', () => {
  it('keeps a proposed-text discussion through workspace switching, completion, and document Undo', async () => {
    const original = 'A prior paragraph.\r\n'
    const proposed = 'A new passage.\r\n'
    io.read.mockResolvedValue(original)
    const { files, wrapper, surface, open } = await setup()
    await open('/work/a.md')
    const x = files.currentFile
    wrapper.vm.mimirReviewProposal({ id: 'comments-review', targetText: original, replacement: proposed })
    await flushPromises()
    await wrapper.setProps({ workspacePath: '/other', workspacePaths: ['/work', '/other'] })
    await open('/other/b.md')
    const y = files.currentFile
    const created = await wrapper.vm.mimirDocumentComment('add', { target: x.path, anchor_text: 'A new passage.', text: 'Check this new claim.' })
    await wrapper.vm.mimirDocumentComment('reply', { target: x.path, comment_id: created.comment_id, text: 'See https://example.com/spec.' })
    expect(files.currentFile).toBe(y)
    expect(x.content).toBe(original)
    await wrapper.setProps({ workspacePath: '/work' })
    await flushPromises()
    expect(wrapper.vm.mimirState({ includeContent: true }).view.content).toBe('A new passage.\n')
    await wrapper.findComponent(DiffBar).findAll('button').find(button => button.text() === 'Accept all').trigger('click')
    await flushPromises()
    expect(useDiffStore().active).toBe(false)
    expect(stripCommentTags(x.content)).toBe(proposed)
    expect(parseCommentTags(x.content).comments[0].replies[0].text).toContain('https://')
    expect(undo(surface.vm.getView())).toBe(true)
    expect(stripCommentTags(x.content)).toBe(original)
    expect(parseCommentTags(x.content).comments[0]).toMatchObject({ detached: 'rejected', quote: 'A new passage.', replies: [{ text: 'See https://example.com/spec.' }] })
    expect(redo(surface.vm.getView())).toBe(true)
    expect(stripCommentTags(x.content)).toBe(proposed)
    expect(parseCommentTags(x.content).comments).toHaveLength(1)
  })

  it('keeps an unsent reply visible after the last decision until it is posted', async () => {
    const original = '<comment id="a" text="Question">Claim</comment> old'
    io.read.mockResolvedValue(original)
    const { wrapper, open, files } = await setup()
    await open('/work/a.md')
    wrapper.vm.mimirReviewProposal({ id: 'draft-review', targetText: 'old', replacement: 'new' })
    await flushPromises()
    await wrapper.find('.review-discussion-bar button').trigger('click')
    await wrapper.find('.review-thread-heading').trigger('click')
    await wrapper.find('.review-discussions textarea').setValue('Pending reply')
    await wrapper.findComponent(DiffBar).findAll('button').find(button => button.text() === 'Accept all').trigger('click')
    await flushPromises()
    expect(useDiffStore().active).toBe(true)
    expect(wrapper.find('.review-discussions textarea').element.value).toBe('Pending reply')
    await wrapper.find('.review-discussions form').trigger('submit')
    await flushPromises()
    expect(useDiffStore().active).toBe(false)
    expect(files.currentFile.content).toContain('text="Pending reply"')
  })
  it('keeps hidden comment edits in their document with separate Undo and Redo', async () => {
    const original = 'First\r\nShared anchor\r\n'
    io.read.mockResolvedValue(original)
    const { files, wrapper, surface, open, type } = await setup()
    await open('/work/a.md')
    type('Unsaved: ')
    const x = files.currentFile
    const snapshot = await wrapper.vm.mimirDocumentState(x.path, true)
    await wrapper.setProps({ workspacePath: '/other', workspacePaths: ['/work', '/other'] })
    await open('/other/b.md')
    const y = files.currentFile
    const result = await wrapper.vm.mimirDocumentComment('add', {
      target: x.path, anchor_text: 'Shared anchor', text: 'Check this.', expected_revision: snapshot.revision,
    })
    await nextTick()
    expect(result).toMatchObject({ path: x.path, saved: false })
    expect(files.currentFile).toBe(y)
    expect(surface.vm.getContent()).toBe(original)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(io.save).not.toHaveBeenCalled()
    await wrapper.setProps({ workspacePath: '/work' })
    await flushPromises()
    expect(surface.vm.getContent()).toBe(x.content)
    expect(surface.vm.getContent()).toContain('<comment')
    expect(undo(surface.vm.getView())).toBe(true)
    expect(x.content).toBe(`Unsaved: ${original}`)
    expect(redo(surface.vm.getView())).toBe(true)
    expect(x.content).toContain('<comment')
    await wrapper.vm.mimirSave()
    expect(io.save).toHaveBeenCalledWith(x.path, x.content)
  })

  it('autosaves a comment in a hidden document through its own save queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { files, wrapper, open } = await setup()
    useSettingsStore().editorAutoSave = true
    await open('/work/a.md')
    const x = files.currentFile
    await wrapper.setProps({ workspacePath: '/other', workspacePaths: ['/work', '/other'] })
    await open('/other/b.md')
    const y = files.currentFile
    await wrapper.vm.mimirDocumentComment('add', { target: x.path, anchor_text: 'Text', text: 'Check this.' })
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save).toHaveBeenCalledWith(x.path, x.content)
    expect(x.dirty).toBe(false)
    expect(files.currentFile).toBe(y)
  })

  it('retains unfinished decisions and Undo when another file is opened', async () => {
    const middle = Array.from({ length: 12 }, (_, i) => `same ${i}`).join('\n')
    const original = `old A\n${middle}\nold B\n${middle}\nold C`
    const proposed = `new A\n${middle}\nnew B\n${middle}\nnew C`
    io.read.mockResolvedValue(original)
    const { files, wrapper, open } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    wrapper.vm.mimirReviewProposal({ id: 'p1', targetText: original, replacement: proposed })
    await flushPromises()
    const diff = useDiffStore()
    const view = EditorView.findFromDOM(wrapper.get('.diff-view .cm-editor').element)
    acceptChunk(view, 0)
    rejectChunk(view, getChunks(view.state).chunks[0].fromB)
    const result = `new A\n${middle}\nold B\n${middle}\nnew C`
    expect(diff.currentReview.result).toBe(result)
    expect(diff.pendingChanges).toBe(1)
    expect(file.content).toBe(original)
    await open('/work/b.md')
    await open('/work/a.md')
    await flushPromises()
    expect(diff.currentReview.result).toBe(result)
    expect(diff.pendingChanges).toBe(1)
    diff.setLayout('split')
    diff.undoReview()
    await flushPromises()
    expect(diff.pendingChanges).toBe(2)
    expect(diff.currentReview.result).toBe(proposed)
    expect(file.content).toBe(original)
  })

  it.each([
    ['unified', 'accept'], ['unified', 'reject'], ['split', 'accept'], ['split', 'reject'],
  ])('automatically applies mixed decisions from %s when the last action is %s', async (layout, last) => {
    const middle = Array.from({ length: 12 }, (_, i) => `same ${i}`).join('\r\n')
    const original = `old A\r\n${middle}\r\nold B`
    const proposed = `new A\r\n${middle}\r\nnew B`
    io.read.mockResolvedValue(original)
    const { files, wrapper, surface, open } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    wrapper.vm.mimirReviewProposal({ id: 'p1', targetText: original, replacement: proposed })
    const diff = useDiffStore()
    diff.setLayout(layout)
    await flushPromises()
    invoke.mockClear()
    const first = last === 'accept' ? 'reject' : 'accept'
    await vi.waitFor(() => expect(wrapper.find(`.diff-view .cm-review-${first}`).exists()).toBe(true))
    await wrapper.get(`.diff-view .cm-review-${first}`).trigger('click')
    expect(diff.pendingChanges).toBe(1)
    expect(file.content).toBe(original)
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', expect.anything())
    diff.setLayout(layout === 'unified' ? 'split' : 'unified')
    await nextTick()
    expect(diff.pendingChanges).toBe(1)
    await vi.waitFor(() => expect(wrapper.find(`.diff-view .cm-review-${last}`).exists()).toBe(true))
    await wrapper.get(`.diff-view .cm-review-${last}`).trigger('click')
    await flushPromises()
    expect(file.content).toBe(last === 'accept' ? `old A\r\n${middle}\r\nnew B` : `new A\r\n${middle}\r\nold B`)
    expect(diff.active).toBe(false)
    const reports = invoke.mock.calls.filter(([command]) => command === 'proposal_respond')
    expect(reports).toHaveLength(1)
    expect(reports[0][1].result).toMatchObject({ id: 'p1', status: 'applied' })
    expect(undo(surface.vm.getView())).toBe(true)
    expect(file.content).toBe(original)
  })

  it.each(['Accept all', 'Reject all'])('completes a review with one click on %s', async label => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    const original = file.content
    wrapper.vm.mimirReviewProposal({ id: 'p1', targetText: original, replacement: 'Proposed' })
    await flushPromises()
    invoke.mockClear()
    await wrapper.findComponent(DiffBar).findAll('button').find(button => button.text() === label).trigger('click')
    await flushPromises()
    expect(useDiffStore().active).toBe(false)
    expect(file.content).toBe(label === 'Accept all' ? 'Proposed' : original)
    expect(invoke).toHaveBeenCalledWith('proposal_respond', { result: expect.objectContaining({ id: 'p1', status: label === 'Accept all' ? 'applied' : 'rejected' }) })
  })

  it('completes a batch after the final file, then waits for Retry if a report fails', async () => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    await open('/work/b.md')
    const b = files.currentFile
    const originalB = b.content
    const diff = useDiffStore()
    diff.activateBatch({ fileList: [
      { path: a.path, original: a.content, modified: 'Accepted A', proposalId: 'p1' },
      { path: b.path, original: b.content, modified: 'Rejected B', proposalId: 'p2' },
    ] })
    diff.focusBatchFile(a.path)
    await flushPromises()
    invoke.mockClear().mockImplementation(async (command, args) => {
      if (command === 'proposal_respond' && args.result.id === 'p2') throw new Error('Registry offline')
    })
    await wrapper.findComponent(DiffBar).get('.review-accept').trigger('click')
    await flushPromises()
    expect(diff.files.map(file => file.review.pending)).toEqual([0, 1])
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', expect.anything())
    diff.focusBatchFile(b.path)
    await nextTick()
    await wrapper.findComponent(DiffBar).get('.review-reject').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(a.content).toBe('Accepted A')
    expect(b.content).toBe(originalB)
    expect(diff.active).toBe(true)
    expect(diff.finishing).toBe(false)
    expect(diff.files[1].error).toContain('Registry offline')
    expect(invoke.mock.calls.filter(([command]) => command === 'proposal_respond')).toHaveLength(2)
    invoke.mockClear().mockResolvedValue(undefined)
    await wrapper.findComponent(DiffBar).findAll('button').find(button => button.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(diff.active).toBe(false)
    expect(invoke.mock.calls.filter(([command]) => command === 'proposal_respond')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('proposal_respond', { result: expect.objectContaining({ id: 'p2', status: 'rejected' }) })
    expect(a.content).toBe('Accepted A')
    expect(b.content).toBe(originalB)
  })

  it('retains a failed review decision across tab switches and retries without replacing newer edits', async () => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    files.setFileReviews(file, [{ proposalId: 'p1', targetText: 'Text', replacement: 'Proposed' }])
    const diff = useDiffStore()
    diff.activate({ original: file.content, modified: 'Proposed text', path: file.path, fileId: file.id, review: { id: 'p1' } })
    diff.decideRemainingChanges('accept')
    let fail
    invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await nextTick()
    await flushPromises()
    expect(file.content).toBe('Proposed text')
    expect(wrapper.findComponent(DiffBar).text()).toContain('Applying…')
    files.updateContent('Newer user text', file)
    fail(new Error('Registry unavailable'))
    await flushPromises()
    expect(wrapper.findComponent(DiffBar).text()).toContain('Retry')
    await open('/work/b.md')
    await open('/work/a.md')
    expect(diff.decision).toBe(file.reviewDecision)
    expect(wrapper.findComponent(DiffBar).text()).toContain('Retry')
    invoke.mockResolvedValueOnce(undefined)
    await wrapper.findComponent(DiffBar).findAll('button').find(button => button.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(file.content).toBe('Newer user text')
    expect(file.reviewDecision).toBeNull()
    expect(diff.active).toBe(false)
  })

  it.each(['open', 'reveal'])('keeps the latest preview when %s reads finish out of order', async command => {
    const { files, wrapper, surface, open } = await setup()
    const reads = new Map()
    io.read.mockImplementation(path => new Promise(resolve => reads.set(path, resolve)))
    const first = command === 'open' ? open('/work/a.md', true)
      : wrapper.vm.mimirReveal({ path: '/work/a.md', preview: true, line: 2, entry: { openBehavior: 'text' } })
    const second = open('/work/b.md', true)
    reads.get('/work/b.md')('File B\nSecond line')
    await second
    reads.get('/work/a.md')('File A\nSecond line')
    expect(await first).toBeNull()
    expect(files.currentFile.path).toBe('/work/b.md')
    expect(surface.vm.getContent()).toBe('File B\nSecond line')
    expect(surface.vm.getCursor().offset).toBe(0)
    expect(wrapper.emitted('navigateEditor').at(-1)).toEqual([{ path: '/work/b.md' }])
  })

  it.each(['tab', 'workspace', 'unmount'])('cancels a pending read after a %s change', async action => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md')
    await open('/work/b.md')
    let finish
    io.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = open('/work/slow.md', true)
    if (action === 'tab') wrapper.vm.mimirCycleTab(-1)
    else if (action === 'workspace') await wrapper.setProps({ workspacePath: '/other', workspacePaths: ['/work', '/other'] })
    else wrapper.unmount()
    finish('Slow text')
    expect(await pending).toBeNull()
    expect(files.openFiles.some(file => file.path === '/work/slow.md')).toBe(false)
  })

  it('closes an untouched preview without a save prompt', async () => {
    const { files, wrapper, open } = await setup()
    await open('/work/a.md', true)
    const id = files.currentFile.id
    expect(await wrapper.vm.mimirCloseActiveTab()).toBe(true)
    expect(files.openFiles.some(file => file.id === id)).toBe(false)
    expect(wrapper.find('[aria-labelledby="close-confirm-title"]').exists()).toBe(false)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('pauses autosave during close confirmation and discards without a later write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore().editorAutoSave = true
    const { files, wrapper, open, type } = await setup()
    await open('/work/a.md')
    const file = files.currentFile
    type('Unsaved: ')
    const closing = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save).not.toHaveBeenCalled()
    await wrapper.get('.btn-discard').trigger('click')
    await closing
    await vi.advanceTimersByTimeAsync(1100)
    expect(files.openFiles).not.toContain(file)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('projects a reload containing protected comment tags exactly', async () => {
    const { files, surface, open } = await setup()
    const original = '<comment id="c1" author="user" text="Check">Old</comment>'
    io.read.mockResolvedValue(original)
    await open('/work/comments.md')
    const content = '<comment id="c2" author="user" text="Updated">New</comment>'
    files.replaceCleanContent(files.currentFile, content)
    await nextTick()
    expect(surface.vm.getContent()).toBe(content)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(files.currentFile.dirty).toBe(false)
  })

  it('keeps the draft open after a failed close-save and allows a successful retry', async () => {
    const { files, wrapper, open, type } = await setup()
    await open('/work/a.md')
    type('Unsaved: ')
    const file = files.currentFile
    io.save.mockRejectedValueOnce(new Error('Disk full'))
    const closing = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    await wrapper.get('.btn-save').trigger('click')
    expect(await closing).toBe(false)
    expect(files.currentFile).toBe(file)
    expect(file).toMatchObject({ content: 'Unsaved: Text of /work/a.md\n', dirty: true, saveState: 'failed' })
    const retry = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    await wrapper.get('.btn-save').trigger('click')
    expect(await retry).toBe(true)
    expect(files.openFiles).not.toContain(file)
    expect(io.save).toHaveBeenLastCalledWith(file.path, file.content)
  })

  it('resumes autosave after Cancel in the close dialog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore().editorAutoSave = true
    const { files, wrapper, open, type } = await setup()
    await open('/work/a.md')
    type('Keep: ')
    const closing = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    await wrapper.get('.btn-cancel').trigger('click')
    expect(await closing).toBe(false)
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save).toHaveBeenCalledWith('/work/a.md', 'Keep: Text of /work/a.md\n')
    expect(files.currentFile.dirty).toBe(false)
  })

  it('replaces a preview document without inheriting text, Undo, or Redo', async () => {
    const { files, surface, open } = await setup()
    await open('/work/a.md', true)
    const a = files.currentFile
    await open('/work/b.md', true)
    const b = files.currentFile
    expect(b.id).not.toBe(a.id)
    expect(files.openFiles).not.toContain(a)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(redo(surface.vm.getView())).toBe(false)
    expect(surface.vm.getContent()).toBe('Text of /work/b.md\n')
    expect(b).toMatchObject({ content: 'Text of /work/b.md\n', dirty: false, preview: true })
    await open('/work/a.md', true)
    expect(undo(surface.vm.getView())).toBe(false)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('keeps each document history through tab switches and a rename', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    type('Edit A: ')
    expect(a.content).toBe('Edit A: Text of /work/a.md\n')
    await open('/work/b.md')
    type('Edit B: ')
    files.moveWorkspacePath('/work/a.md', '/work/renamed.md')
    await open('/work/renamed.md')
    expect(files.currentFile.id).toBe(a.id)
    expect(undo(surface.vm.getView())).toBe(true)
    expect(a.content).toBe('Text of /work/a.md\n')
    expect(a.dirty).toBe(false)
    expect(redo(surface.vm.getView())).toBe(true)
    expect(a.dirty).toBe(true)
    await open('/work/b.md')
    expect(undo(surface.vm.getView())).toBe(true)
    expect(files.currentFile.content).toBe('Text of /work/b.md\n')
  })

  it('saves typing made during another file read, including when both files are edited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore().editorAutoSave = true
    const { files, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    let finishRead
    io.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const opening = open('/work/b.md')
    type('During read: ')
    expect(a.content).toBe('During read: Text of /work/a.md\n')
    finishRead('File B\n')
    await opening
    type('Edit B: ')
    await vi.advanceTimersByTimeAsync(1100)
    expect(io.save.mock.calls).toEqual([
      ['/work/a.md', 'During read: Text of /work/a.md\n'],
      ['/work/b.md', 'Edit B: File B\n'],
    ])
    expect(a.dirty).toBe(false)
    expect(files.currentFile.dirty).toBe(false)
  })

  it('binds editor events to the loaded document during a pending render and rejects closed documents', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    const a = files.currentFile
    const opening = files.openFile('/work/b.md', 'B')
    type('Before render: ')
    expect(a.content).toBe('Before render: Text of /work/a.md\n')
    expect(files.currentFile).toMatchObject({ content: 'B', dirty: false })
    await opening
    await nextTick()
    files.closeFile(files.openFiles.indexOf(a), { ensureOne: false })
    surface.vm.$emit('change', { fileId: a.id, content: 'late text' })
    expect(files.currentFile).toMatchObject({ content: 'B', dirty: false })
  })

  it.each(['\n', '\r\n', '\r'])('keeps line endings %j and a clean saved baseline through open, edit, undo, and save', async ending => {
    const content = ['first', 'second', ''].join(ending)
    io.read.mockResolvedValue(content)
    const { files, wrapper, surface, open, type } = await setup()
    await open('/work/lines.md', true)
    expect(wrapper.vm.mimirState({ includeContent: true }).active).toMatchObject({ content, dirty: false })
    type('New: ')
    expect(files.currentFile.content).toBe(`New: ${content}`)
    undo(surface.vm.getView())
    expect(files.currentFile).toMatchObject({ content, dirty: false })
    redo(surface.vm.getView())
    await wrapper.vm.mimirSave()
    expect(io.save).toHaveBeenCalledWith('/work/lines.md', `New: ${content}`)
    undo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(true)
    redo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(false)
  })

  it('does not add external reloads to Undo, but retains an accepted edit as an undo step', async () => {
    const { files, surface, open } = await setup()
    await open('/work/a.md')
    files.replaceCleanContent(files.currentFile, 'External text\n')
    await nextTick()
    expect(undo(surface.vm.getView())).toBe(false)
    files.updateContent('Accepted proposal\n', files.currentFile)
    await nextTick()
    expect(undo(surface.vm.getView())).toBe(true)
    expect(files.currentFile).toMatchObject({ content: 'External text\n', dirty: false })
  })

  it('replaces a CRLF document through the command API without using disk offsets', async () => {
    io.read.mockResolvedValue('First\r\nSecond\r\n')
    const { files, wrapper, surface, open } = await setup()
    await open('/work/windows.md')
    wrapper.vm.mimirSetContent('Replacement\ntext\n')
    expect(files.currentFile.content).toBe('Replacement\r\ntext\r\n')
    expect(undo(surface.vm.getView())).toBe(true)
    expect(files.currentFile).toMatchObject({ content: 'First\r\nSecond\r\n', dirty: false })
  })

  it('uses editor positions for inline edits and preserves line endings in the preview', async () => {
    const content = 'One\r\nTwo\r\nThree'
    io.read.mockResolvedValue(content)
    const { files, wrapper, surface, open } = await setup()
    await open('/work/windows.md')
    const selection = { from: 4, to: 7, text: 'Two', force: true, coords: { left: 0, top: 0 } }
    surface.vm.$emit('selection-command', selection)
    await nextTick()
    const inline = wrapper.findComponent({ name: 'InlineAI' })
    expect(inline.props('selection')).toMatchObject({ contextBefore: 'One\n', contextAfter: '\nThree' })
    inline.vm.$emit('activate-diff', { ...selection, replacement: 'Updated' })
    expect(useDiffStore()).toMatchObject({ originalContent: content, modifiedContent: 'One\r\nUpdated\r\nThree' })
    expect(files.currentFile).toMatchObject({ content, dirty: false })
    inline.vm.$emit('apply', 'Updated', selection.from, selection.to)
    expect(files.currentFile.content).toBe('One\r\nUpdated\r\nThree')
  })

  it('keeps edits dirty when an earlier save completes and saves the current text next', async () => {
    const { files, surface, open, type } = await setup()
    await open('/work/a.md')
    type('First: ')
    let finishWrite
    io.save.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve }))
    const saving = files.save()
    undo(surface.vm.getView())
    expect(files.currentFile.dirty).toBe(true)
    finishWrite()
    expect(await saving).toBe(false)
    expect(files.currentFile.dirty).toBe(true)
    await files.save()
    expect(io.save).toHaveBeenLastCalledWith('/work/a.md', 'Text of /work/a.md\n')
    expect(files.currentFile.dirty).toBe(false)
  })

  it('retains immediate edits in session snapshots and uses disk text as the restored baseline', async () => {
    const { files, open, type } = await setup()
    await open('/work/a.md')
    type('Draft: ')
    const snapshot = createSessionSnapshot({ openFiles: { value: files.openFiles }, activeFileIndex: { value: files.activeFileIndex }, recentFiles: { value: [] }, zoomLevel: { value: 100 } })
    const entry = snapshot.openFiles.find(file => file.path === '/work/a.md')
    expect(entry).toMatchObject({ content: 'Draft: Text of /work/a.md\n', dirty: true })
    files.closeFile(files.activeFileIndex, { ensureOne: false })
    files.restorePath({ ...entry, savedContent: 'Text of /work/a.md\n' })
    files.updateContent('Text of /work/a.md\n')
    expect(files.currentFile.dirty).toBe(false)
  })
})
