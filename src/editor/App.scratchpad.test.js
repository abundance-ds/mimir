import { nextTick, watch } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { redo, undo } from '@codemirror/commands'
import App from './App.vue'
import EditorSurface from './components/workspace/EditorSurface.vue'
import { useFileStore } from '../stores/files.js'
import { useScratchpadStore } from '../stores/scratchpad.js'

vi.mock('../services/session.js', () => ({ loadSession: vi.fn(async () => null), saveSession: vi.fn(async () => {}) }))
vi.mock('./nativeMenu.js', () => ({ installNativeEditorMenu: vi.fn(async () => true), shouldInstallNativeEditorMenu: () => false }))
enableAutoUnmount(afterEach)

const path = '/home/.mimir/scratchpad.md'
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'read_text_file') return { content: args.path === path ? 'Scratchpad text' : 'Ordinary note' }
    return null
  })
  const store = useScratchpadStore()
  store.path = path
  store.content = 'Scratchpad text'
  store.history = [{ time: 1, content: store.content }]
})

async function setup() {
  const files = useFileStore()
  await files.openFile(path, 'Scratchpad text', { meta: { scratchpad: true } })
  const scratchpad = files.currentFile
  await files.openFile('/work/ordinary.md', 'Ordinary note')
  const wrapper = mount(App, {
    props: { embedded: true, workspacePath: '/work', workspacePaths: ['/work', '/other'] },
    global: { stubs: { AppHeader: true, AppFooter: true, SettingsDialog: true, NewTabPage: true, InlineAI: true, GitDiffView: true } },
  })
  await flushPromises()
  const surface = wrapper.findComponent(EditorSurface)
  expect(surface.vm.getContent()).toBe('Ordinary note')
  return { wrapper, files, scratchpad, surface, store: useScratchpadStore() }
}

it('keeps a concurrent Scratchpad refresh separate from the project document during a workspace switch', async () => {
  const { wrapper, scratchpad, surface, store, files } = await setup()
  const switching = wrapper.setProps({ workspacePath: '/other' })
  store.content = 'Latest scratchpad text'
  await switching
  await flushPromises()
  expect(files.currentFile).toBe(scratchpad)
  expect(scratchpad.content).toBe('Latest scratchpad text')
  expect(scratchpad.dirty).toBe(false)
  expect(surface.vm.getContent()).toBe('Latest scratchpad text')
  undo(surface.vm.getView())
  await nextTick()
  expect(surface.vm.getContent()).not.toContain('Ordinary note')
})

it('keeps a Scratchpad refresh separate from the file shown before a tab switch', async () => {
  const { scratchpad, surface, store, files } = await setup()
  files.setActiveTab(files.openFiles.indexOf(scratchpad))
  store.content = 'Latest scratchpad text'
  await nextTick()
  expect(files.currentFile).toBe(scratchpad)
  expect(scratchpad.content).toBe('Latest scratchpad text')
  expect(scratchpad.dirty).toBe(false)
  expect(surface.vm.getContent()).toBe('Latest scratchpad text')
})

it('keeps refresh after workspace selection separate from the outgoing CodeMirror document', async () => {
  const { wrapper, scratchpad, surface, store, files } = await setup()
  // Force the refresh between workspace selection and the surface's
  // post-render document switch. The other test covers the earlier order.
  const stop = watch(() => files.workspaceScope, () => { store.content = 'Latest scratchpad text' })
  try {
    await wrapper.setProps({ workspacePath: '/other' })
    expect(files.currentFile).toBe(scratchpad)
    expect(scratchpad.content).toBe('Latest scratchpad text')
    expect(scratchpad.dirty).toBe(false)
    expect(surface.vm.getContent()).toBe('Latest scratchpad text')
  } finally { stop() }
})

it('does not put the other file into Scratchpad undo history', async () => {
  const { wrapper, scratchpad, surface, store, files } = await setup()
  await wrapper.vm.mimirOpen(path)
  await wrapper.vm.mimirOpen('/work/ordinary.md')
  files.setActiveTab(files.openFiles.indexOf(scratchpad))
  store.content = 'Latest scratchpad text'
  await nextTick()
  const view = surface.vm.getView()
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'My new scratchpad text' }, userEvent: 'input.paste' })
  expect(undo(view)).toBe(true)
  expect(surface.vm.getContent()).toBe('Latest scratchpad text')
  expect(redo(view)).toBe(true)
  expect(surface.vm.getContent()).toBe('My new scratchpad text')
})

it('retains pending Scratchpad typing and undo during a project switch with an external refresh', async () => {
  const { wrapper, scratchpad, surface, store, files } = await setup()
  await wrapper.vm.mimirOpen(path)
  const view = surface.vm.getView()
  view.dispatch({ changes: { from: 0, insert: 'My edit: ' }, userEvent: 'input.type' })
  // The draft is authoritative before a project switch or external refresh.
  expect(scratchpad.content).toBe('My edit: Scratchpad text')
  const switching = wrapper.setProps({ workspacePath: '/other' })
  store.content = 'External scratchpad text'
  await switching
  expect(files.currentFile).toBe(scratchpad)
  expect(scratchpad.content).toBe('My edit: Scratchpad text')
  expect(scratchpad.dirty).toBe(true)
  expect(surface.vm.getContent()).toBe('My edit: Scratchpad text')
  expect(undo(view)).toBe(true)
  expect(surface.vm.getContent()).toBe('Scratchpad text')
})
