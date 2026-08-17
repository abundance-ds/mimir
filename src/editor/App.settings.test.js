import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFile, loadSession, saveSession } = vi.hoisted(() => ({
  readFile: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
}))
const nativeMenu = vi.hoisted(() => ({
  install: vi.fn(async () => true),
}))

vi.mock('../services/fileSystem.js', () => ({ readFile }))
vi.mock('../services/session.js', () => ({ loadSession, saveSession }))
vi.mock('./nativeMenu.js', () => ({
  installNativeEditorMenu: nativeMenu.install,
  shouldInstallNativeEditorMenu: vi.fn(() => false),
}))
vi.mock('./sessionPersist.js', () => ({
  createSessionPersist: vi.fn(() => {
    const dispose = vi.fn()
    dispose.flush = vi.fn(async () => {})
    return dispose
  }),
  createSessionSnapshot: vi.fn(() => ({})),
}))

import { useFileStore } from '../stores/files.js'
import { useDiffStore } from '../stores/diff.js'
import { useSettingsStore } from '../stores/settings.js'
import App from './App.vue'

const SettingsDialogStub = defineComponent({
  props: {
    open: Boolean,
    initialSection: String,
  },
  emits: ['close'],
  template: `
    <div v-if="open" data-settings-stub />
  `,
})

const EditorSurfaceStub = defineComponent({
  setup(_, { expose }) {
    expose({
      getContent: () => '',
      getCursor: () => null,
      hasFocus: () => false,
      scrollToPos: vi.fn(),
    })
    return () => null
  },
})

describe('Editor Settings bridge', () => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    readFile.mockReset().mockResolvedValue('id = "ledger"')
    loadSession.mockReset().mockResolvedValue(null)
    saveSession.mockReset().mockResolvedValue()
    nativeMenu.install.mockClear()
  })

  it('consumes native Close Tab by dismissing teleported Settings first', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(App, {
      props: { embedded: true },
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: true,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: true,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })
    await flushPromises()

    wrapper.vm.mimirOpenSettings('appearance')
    await flushPromises()
    expect(wrapper.find('[data-settings-stub]').exists()).toBe(true)

    expect(await wrapper.vm.mimirCloseActiveTab()).toBe(true)
    await flushPromises()

    expect(wrapper.find('[data-settings-stub]').exists()).toBe(false)
    expect(wrapper.emitted('closeRequest')).toBeFalsy()
    expect(useFileStore().openFiles).toHaveLength(1)
    wrapper.unmount()
  })

  it('hands native Go to and New to the Workbench when the Editor is embedded', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(App, {
      props: { embedded: true },
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: true,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: true,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })
    await flushPromises()
    const actions = nativeMenu.install.mock.calls.at(-1)[0].actions
    const initialFiles = useFileStore().openFiles.length

    actions.openQuickOpen()
    actions.newFile()

    expect(wrapper.emitted('quickOpenRequest')).toHaveLength(1)
    expect(wrapper.emitted('newRequest')).toHaveLength(1)
    expect(useFileStore().openFiles).toHaveLength(initialFiles)
    wrapper.unmount()
  })

  it('gives dirty-close confirmation full modal semantics, safe initial focus, and a focus trap', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const HeaderWithOrigin = defineComponent({
      template: '<button data-editor-origin>Editor origin</button>',
    })
    const wrapper = mount(App, {
      props: { embedded: true },
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: HeaderWithOrigin,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: true,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })
    await flushPromises()
    const origin = wrapper.get('[data-editor-origin]')
    origin.element.focus()
    const store = useFileStore()
    store.currentFile.content = 'unsaved'
    store.currentFile.dirty = true

    const closing = wrapper.vm.mimirCloseActiveTab()
    await flushPromises()
    const dialog = wrapper.get('[role="dialog"][aria-labelledby="close-confirm-title"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    const cancel = dialog.get('[data-modal-initial]')
    const save = dialog.findAll('button').at(-1)
    expect(document.activeElement).toBe(cancel.element)

    await cancel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save.element)
    await save.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(cancel.element)

    await dialog.trigger('keydown', { key: 'Escape' })
    await expect(closing).resolves.toBe(false)
    await vi.waitFor(() => {
      expect(wrapper.find('[aria-labelledby="close-confirm-title"]').exists()).toBe(false)
    })
    expect(document.activeElement).toBe(origin.element)
    wrapper.unmount()
  })

  it('recovers from a failed session read with one usable fallback document', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    loadSession.mockRejectedValueOnce(new Error('session unreadable'))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mount(App, {
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: true,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: true,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })

    await vi.waitFor(() => expect(useFileStore().openFiles).toHaveLength(1))
    expect(useFileStore().currentFile).toMatchObject({
      path: null,
      content: '',
    })
    expect(diagnostic).toHaveBeenCalledWith(
      '[session] persistence failed',
      expect.objectContaining({ message: 'session unreadable' }),
    )
    wrapper.unmount()
    diagnostic.mockRestore()
  })

  it('mounts the Markdown toolbar in the real editor flow and obeys the Editor setting', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(App, {
      props: { embedded: true },
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: true,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: true,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })
    await flushPromises()
    const settings = useSettingsStore(pinia)
    const files = useFileStore(pinia)

    expect(wrapper.find('[data-editor-toolbar]').exists()).toBe(true)
    settings.set('editorToolbarMode', 'none')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-editor-toolbar]').exists()).toBe(false)

    settings.set('editorToolbarMode', 'top')
    files.currentFile.path = '/work/main.rs'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-editor-toolbar]').exists()).toBe(false)

    files.currentFile.path = '/work/notes.md'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-editor-toolbar]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hides a review outside its exact project tab and restores it on return', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const files = useFileStore(pinia)
    const diff = useDiffStore(pinia)
    const alpha = await files.openFile('/alpha/a.md', '', { workspacePath: '/alpha' })
    await files.openFile('/beta/b.md', '', { workspacePath: '/beta' })
    diff.activate({
      original: 'old',
      modified: 'new',
      path: alpha.path,
      fileId: alpha.id,
    })
    const DiffViewStub = defineComponent({
      template: '<div data-diff-view-stub />',
    })
    const wrapper = mount(App, {
      props: {
        embedded: true,
        workspacePath: '/alpha',
        workspacePaths: ['/alpha', '/beta'],
      },
      global: {
        plugins: [pinia],
        stubs: {
          AppHeader: true,
          AppFooter: true,
          SettingsDialog: SettingsDialogStub,
          EditorSurface: EditorSurfaceStub,
          InlineAI: true,
          DiffBar: true,
          DiffView: DiffViewStub,
          BatchDiffView: true,
          NewTabPage: true,
          Teleport: true,
          Transition: false,
        },
      },
    })
    await flushPromises()

    expect(files.currentFile.id).toBe(alpha.id)
    expect(wrapper.find('[data-diff-view-stub]').exists()).toBe(true)

    await wrapper.setProps({ workspacePath: '/beta' })
    await flushPromises()
    expect(files.currentFile.path).toBe('/beta/b.md')
    expect(wrapper.find('[data-diff-view-stub]').exists()).toBe(false)
    expect(diff.active).toBe(true)

    await wrapper.setProps({ workspacePath: '/alpha' })
    await flushPromises()
    expect(files.currentFile.id).toBe(alpha.id)
    expect(wrapper.find('[data-diff-view-stub]').exists()).toBe(true)
    expect(diff.active).toBe(true)
    wrapper.unmount()
  })
})
