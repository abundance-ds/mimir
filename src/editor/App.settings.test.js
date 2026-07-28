import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFile, loadSession, saveSession } = vi.hoisted(() => ({
  readFile: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
}))

vi.mock('../services/fileSystem.js', () => ({ readFile }))
vi.mock('../services/session.js', () => ({ loadSession, saveSession }))
vi.mock('./nativeMenu.js', () => ({
  installNativeEditorMenu: vi.fn(async () => () => {}),
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
import { useSettingsStore } from '../stores/settings.js'
import App from './App.vue'

const SettingsDialogStub = defineComponent({
  props: {
    open: Boolean,
    initialSection: String,
  },
  emits: ['close', 'launchApp', 'openDefinition'],
  template: `
    <div v-if="open" data-settings-stub>
      <button
        data-open-app-definition
        @click="$emit('openDefinition', '/home/me/.mimir/apps/ledger/app.toml')"
      >
        Open definition
      </button>
    </div>
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

describe('Editor Apps Settings bridge', () => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    readFile.mockReset().mockResolvedValue('id = "ledger"')
    loadSession.mockReset().mockResolvedValue(null)
    saveSession.mockReset().mockResolvedValue()
  })

  it('closes Settings and opens a local app definition in the right-hand Editor', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
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
    await flushPromises()

    wrapper.vm.mimirOpenSettings('apps')
    await flushPromises()
    await wrapper.get('[data-open-app-definition]').trigger('click')
    await flushPromises()

    expect(readFile).toHaveBeenCalledWith('/home/me/.mimir/apps/ledger/app.toml')
    expect(useFileStore().currentFile?.path).toBe('/home/me/.mimir/apps/ledger/app.toml')
    expect(wrapper.find('[data-settings-stub]').exists()).toBe(false)
    expect(wrapper.emitted('navigateEditor')).toEqual([[
      { path: '/home/me/.mimir/apps/ledger/app.toml' },
    ]])
    wrapper.unmount()
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

    wrapper.vm.mimirOpenSettings('apps')
    await flushPromises()
    expect(wrapper.find('[data-settings-stub]').exists()).toBe(true)

    expect(await wrapper.vm.mimirCloseActiveTab()).toBe(true)
    await flushPromises()

    expect(wrapper.find('[data-settings-stub]').exists()).toBe(false)
    expect(wrapper.emitted('closeRequest')).toBeFalsy()
    expect(useFileStore().openFiles).toHaveLength(1)
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
})
