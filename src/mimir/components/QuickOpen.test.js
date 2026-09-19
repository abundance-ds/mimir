import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { useSettingsStore } from '../../stores/settings.js'
import { buildNativeEditorMenuItems } from '../../editor/nativeMenu.js'
import QuickOpen from './QuickOpen.vue'
import { buildQuickOpenResults } from '../quickOpenResults.js'

const activityApi = vi.hoisted(() => ({
  searchHistory: vi.fn(),
}))

vi.mock('../quickOpenResults.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, buildQuickOpenResults: vi.fn(actual.buildQuickOpenResults) }
})

vi.mock('../../services/activities.js', () => ({
  searchActivityHistory: activityApi.searchHistory,
}))

vi.mock('../../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(),
  filterIndexedFiles: vi.fn().mockResolvedValue([]),
  refreshWorkspaceIndex: vi.fn(),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

const tools = [
  { id: 'core:files', title: 'Files', icon: 'files' },
  { id: 'app:scratch', title: 'Today', icon: 'today' },
]
const launchers = [
  { id: 'preset:codex', title: 'Codex', icon: 'codex' },
]
const projects = [
  { name: 'current', path: '/w', current: true },
  { name: 'other-project', path: '/work/other-project' },
]
const history = [{
  id: 'agent:closed',
  kind: 'agent',
  title: 'Codex',
  status: 'done',
  workspacePath: '/w',
  createdAt: '2026-07-25T10:00:00Z',
  updatedAt: '2026-07-25T11:00:00Z',
  archivedAt: '2026-07-25T12:00:00Z',
  source: { presetId: 'codex' },
}]
const unavailableActivities = [{
  id: 'agent:orphaned',
  kind: 'agent',
  title: 'Recover release notes',
  status: 'interrupted',
  workspacePath: '/work/removed',
  source: { presetId: 'codex' },
}]

enableAutoUnmount(afterEach)

describe('QuickOpen', () => {
  let pinia

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    pinia = createPinia()
    setActivePinia(pinia)
    vi.mocked(buildQuickOpenResults).mockClear()
    activityApi.searchHistory.mockReset()
    activityApi.searchHistory.mockResolvedValue([])
    const files = useWorkspaceFilesStore()
    files.workspacePath = '/w'
    files.files = [
      { path: '/w/a.md', name: 'a.md', relativePath: 'a.md', mtime: 2 },
      { path: '/w/b.rs', name: 'b.rs', relativePath: 'src/b.rs', mtime: 1 },
    ]
  })

  function render(open = true, options = {}) {
    return mount(QuickOpen, {
      ...options,
      props: {
        open,
        tools,
        projects,
        currentProjectPath: '/w',
        newActivity: launchers,
        history,
        ...(options.props || {}),
      },
      global: {
        plugins: [pinia],
        stubs: {
          Teleport: true,
          Transition: false,
          IconProviderOpenAI: true,
          IconProviderAnthropic: true,
        },
        ...(options.global || {}),
      },
    })
  }

  it.each([
    ['t', 'app:scratch'], ['g', 'app:business-graph'], ['s', 'app:scribe'],
    ['d', 'core:scratchpad'], ['r', 'core:routines'], ['l', 'app:tracker'], ['j', 'core:chats'],
  ])('opens %s through the existing tool action, even when search has no results', async (key, targetId) => {
    const wrapper = render(true, { props: { tools: [{ id: targetId, title: 'Tool', available: true }] } })
    await flushPromises()
    const input = wrapper.get('[data-quick-open-input]')
    await input.setValue('no matching result')
    await input.trigger('keydown', { key, metaKey: true })
    expect(wrapper.emitted('activate')).toEqual([[{ type: 'tool', targetId }]])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('keeps tool chords fixed across reordering and hides unavailable tools', async () => {
    const graph = { id: 'app:business-graph', title: 'Graph' }
    const wrapper = render(true, { props: { tools: [graph, ...tools] } })
    const bindings = () => wrapper.findAll('[data-quick-open-chord]').map(row => row.attributes('data-quick-open-chord'))
    const initial = bindings()
    await wrapper.setProps({ tools: [...tools, graph] })
    expect(bindings()).toEqual(initial)
    expect(bindings()).not.toContain('go-to-tracker')
    await wrapper.setProps({ tools: [{ ...graph, available: false }, ...tools] })
    expect(bindings()).not.toContain('go-to-graph')
    await wrapper.get('input').trigger('keydown', { key: 'g', metaKey: true })
    expect(wrapper.emitted('activate')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('numbers only available AI presets in launcher order, caps at nine, and uses zero for Terminal', async () => {
    const agents = Array.from({ length: 10 }, (_, index) => ({ id: `preset:agent-${index}`, title: `Agent ${index}`, kind: 'agent' }))
    const wrapper = render(true, { props: { newActivity: [
      { id: 'preset:missing', title: 'Missing', kind: 'agent', available: false },
      { id: 'preset:disabled', title: 'Disabled', kind: 'agent', enabled: false },
      { id: 'app:local', title: 'Local app', kind: 'agent' },
      { id: 'preset:terminal', title: 'Terminal', kind: 'terminal' }, ...agents,
    ] } })
    expect(wrapper.get('[data-quick-open-chord="go-to-agent-1"]').text()).toContain('New Agent 0')
    expect(wrapper.get('[data-quick-open-chord="go-to-agent-9"]').text()).toContain('New Agent 8')
    expect(wrapper.find('[data-quick-open-chord="go-to-agent-10"]').exists()).toBe(false)
    await wrapper.get('input').trigger('keydown', { key: '9', metaKey: true })
    expect(wrapper.emitted('activate').at(-1)[0]).toEqual({ type: 'new-activity', targetId: 'preset:agent-8' })
    await wrapper.get('[data-quick-open-chord="go-to-terminal"]').trigger('click')
    expect(wrapper.emitted('activate').at(-1)[0]).toEqual({ type: 'new-activity', targetId: 'preset:terminal' })
    await wrapper.setProps({ newActivity: [agents[1], agents[0]] })
    await wrapper.get('input').trigger('keydown', { key: '1', metaKey: true })
    expect(wrapper.emitted('activate').at(-1)[0].targetId).toBe('preset:agent-1')
    await wrapper.get('input').trigger('keydown', { key: '9', metaKey: true })
    await wrapper.get('input').trigger('keydown', { key: '0', metaKey: true })
    expect(wrapper.emitted('activate')).toHaveLength(3)
  })

  it('opens a project folder from the chord and native Open menu action', async () => {
    const wrapper = render(true, { attachTo: document.body })
    await wrapper.get('input').trigger('keydown', { key: 'o', metaKey: true })
    expect(wrapper.emitted('activate')[0][0]).toEqual({ type: 'project-open' })
    const openFile = vi.fn()
    const menu = buildNativeEditorMenuItems([], { openFile }).flatMap(section => section.items)
    menu.find(item => item.id === 'editor:open-file').action()
    await flushPromises()
    expect(wrapper.emitted('activate')).toHaveLength(2)
    expect(openFile).not.toHaveBeenCalled()
    await wrapper.setProps({ open: false })
    menu.find(item => item.id === 'editor:open-file').action()
    await flushPromises()
    expect(openFile).toHaveBeenCalledOnce()
  })

  it('switches to the project picker without waiting for a pending search', async () => {
    const wrapper = render(true, { attachTo: document.body })
    await flushPromises()
    const input = wrapper.get('input')
    await input.setValue('unrelated text')
    const search = vi.spyOn(useWorkspaceFilesStore(), 'setQuery').mockImplementation(() => new Promise(() => {}))
    await input.trigger('keydown', { key: 'p', metaKey: true, repeat: true })
    expect(input.element.value).toBe('unrelated text')
    await input.trigger('keydown', { key: 'p', metaKey: true })
    expect(input.element.value).toBe('p: ')
    expect(input.element.selectionStart).toBe(3)
    expect(document.activeElement).toBe(input.element)
    expect(wrapper.findAll('[data-quick-open-type="project"]')).toHaveLength(1)
    expect(wrapper.get('[aria-selected="true"]').attributes('data-quick-open-key')).toBe('project:/work/other-project')
    expect(wrapper.emitted('close')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('activate')[0][0]).toMatchObject({ type: 'project', path: '/work/other-project' })
    search.mockRestore()
  })

  it('opens Files search from a nested view and keeps all tool chords available', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-new-tab]').trigger('click')
    await wrapper.get('input').trigger('keydown', { key: 'f', metaKey: true })
    expect(wrapper.get('input').element.value).toBe('f: ')
    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('Files')
    expect(wrapper.find('[data-quick-open-back]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-chord="go-to-today"]').exists()).toBe(true)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it.each(['tabs', 'projects', 'new-activity'])('does not enable tool chords from the %s entry point', async initialView => {
    const wrapper = render(true, { props: { initialView } })
    await wrapper.get('input').trigger('keydown', { key: 't', metaKey: true })
    expect(wrapper.find('[data-quick-open-shortcuts]').exists()).toBe(false)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('leaves typing, text editing, modified keys, and IME input alone', async () => {
    const wrapper = render()
    await flushPromises()
    const input = wrapper.get('input')
    await input.setValue('today')
    for (const options of [
      { key: 't' }, { key: 't', ctrlKey: true }, { key: 'T', metaKey: true, shiftKey: true },
      { key: 't', metaKey: true, altKey: true }, { key: 't', metaKey: true, isComposing: true },
      { key: 't', metaKey: true, keyCode: 229 },
      ...['a', 'c', 'v', 'x', 'z'].map(key => ({ key, metaKey: true })),
    ]) {
      const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
      input.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(input.element.value).toBe('today')
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('keeps minimized chords active and restores search focus without changing the query', async () => {
    const wrapper = render(true, { attachTo: document.body })
    await flushPromises()
    const input = wrapper.get('input')
    await input.setValue('draft')
    await wrapper.get('[data-quick-open-shortcuts-minimize]').trigger('click')
    expect(useSettingsStore().quickOpenShortcutsMinimized).toBe(true)
    expect(wrapper.find('[data-quick-open-shortcuts]').exists()).toBe(false)
    expect(document.activeElement).toBe(input.element)
    expect(input.element.value).toBe('draft')
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(wrapper.get('[data-quick-open-shortcuts-restore]').element)
    await wrapper.setProps({ open: false })
    expect(wrapper.find('[data-quick-open-shortcuts-restore]').exists()).toBe(false)
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.find('[data-quick-open-shortcuts-restore]').exists()).toBe(true)
    await wrapper.get('[data-quick-open-shortcuts-restore]').trigger('click')
    expect(wrapper.find('[data-quick-open-shortcuts]').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('input').element)
    await wrapper.get('[data-quick-open-shortcuts-minimize]').trigger('click')
    await wrapper.get('input').trigger('keydown', { key: 't', metaKey: true })
    expect(wrapper.emitted('activate')[0][0]).toEqual({ type: 'tool', targetId: 'app:scratch' })
  })

  it('routes native Mac menu accelerators to Go to, then restores their normal actions', async () => {
    const actions = { openQuickOpen: vi.fn(), save: vi.fn(), editCommand: vi.fn() }
    const menu = buildNativeEditorMenuItems([], actions).flatMap(section => section.items)
    const wrapper = render(true, { attachTo: document.body, props: { tools: [{ id: 'app:scribe', title: 'Scribe' }] } })
    await flushPromises()
    menu.find(item => item.id === 'workbench:go-to').action()
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('p: ')
    menu.find(item => item.id === 'editor:find').action()
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('f: ')
    menu.find(item => item.id === 'editor:save').action()
    await flushPromises()
    expect(wrapper.emitted('activate')[0][0]).toEqual({ type: 'tool', targetId: 'app:scribe' })
    expect(actions.save).not.toHaveBeenCalled()
    expect(actions.editCommand).not.toHaveBeenCalled()
    expect(actions.openQuickOpen).not.toHaveBeenCalled()
    await wrapper.setProps({ open: false })
    for (const id of ['workbench:go-to', 'editor:find', 'editor:save']) menu.find(item => item.id === id).action()
    await flushPromises()
    expect(actions.openQuickOpen).toHaveBeenCalledOnce()
    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.editCommand).toHaveBeenCalledWith('find')
  })

  it('does no result building while closed and reopens with the latest context', async () => {
    const files = useWorkspaceFilesStore()
    const readFileName = vi.fn(() => 'latest.md')
    const wrapper = render(false)
    files.files = [{ path: '/w/latest.md', relativePath: 'latest.md', get name() { return readFileName() } }]
    await wrapper.setProps({ documents: [{ id: 'first-draft', name: 'First draft' }] })
    await flushPromises()
    expect(buildQuickOpenResults).not.toHaveBeenCalled()
    expect(readFileName).not.toHaveBeenCalled()

    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(buildQuickOpenResults).toHaveBeenCalled()
    expect(readFileName).toHaveBeenCalled()
    expect(wrapper.text()).toContain('First draft')
    await wrapper.get('[data-quick-open-input]').setValue('old search')
    await wrapper.setProps({ open: false })
    await flushPromises()
    vi.mocked(buildQuickOpenResults).mockClear()
    readFileName.mockClear().mockReturnValue('updated.md')

    files.files = [{ path: '/w/updated.md', relativePath: 'updated.md', get name() { return readFileName() } }]
    await wrapper.setProps({
      documents: [{ id: 'latest-draft', name: 'Latest draft' }],
      tools: [{ id: 'core:latest', title: 'Latest tool', icon: 'files' }],
      projects: [{ name: 'latest-project', path: '/work/latest-project' }],
      activities: [{ id: 'latest-agent', title: 'Latest activity', kind: 'agent', status: 'idle' }],
    })
    await flushPromises()
    expect(buildQuickOpenResults).not.toHaveBeenCalled()
    expect(readFileName).not.toHaveBeenCalled()
    expect(activityApi.searchHistory).not.toHaveBeenCalled()

    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.get('[data-quick-open-input]').element.value).toBe('')
    expect(wrapper.text()).toContain('Latest draft')
    expect(wrapper.text()).toContain('Latest tool')
    expect(wrapper.text()).toContain('Latest activity')
    expect(wrapper.text()).toContain('latest-project')
    expect(wrapper.get('[data-quick-open-type="file"]').text()).toContain('updated.md')
    expect(wrapper.text()).not.toContain('First draft')
    expect(readFileName).toHaveBeenCalled()
    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('activate')[0][0]).toMatchObject({ type: 'document', documentId: 'latest-draft' })
  })

  it('does not return focus to the opener after selecting a destination', async () => {
    const opener = document.createElement('button')
    const destination = document.createElement('button')
    document.body.append(opener, destination)
    opener.focus()
    const w = render(true, { attachTo: document.body, props: { documents: [{ id: 'draft', name: 'Untitled' }], onActivate: () => destination.focus() } })
    await flushPromises()
    await w.get('input').trigger('keydown', { key: 'Enter' })
    await w.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(destination)
    w.unmount()
    opener.remove()
    destination.remove()
  })

  it('selects an open unsaved document by keyboard and keeps New tab available', async () => {
    const w = render(true, { props: { documents: [{ id: 'draft', name: 'Untitled' }] } })
    await flushPromises()
    const input = w.get('input')
    await input.setValue('untitled')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('activate')[0][0]).toMatchObject({ type: 'document', documentId: 'draft' })
    await input.setValue('no such entry')
    await w.get('[data-quick-open-new-tab]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Codex')
  })

  it('shows a compact new-activity row, recent files, and history without live activities', () => {
    const wrapper = render()
    expect(wrapper.findAll('[data-quick-open-type]').map((row) => row.attributes('data-quick-open-type'))).toEqual([
      'new-activity-enter',
      'tool',
      'tool',
      'project',
      'file',
      'file',
      'history',
    ])
    expect(wrapper.findAll('[data-quick-open-type="file"]').map((row) => row.text())).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('b.rs'),
    ])
    expect(wrapper.text()).toContain('Reopen last closed activity')
    expect(wrapper.get('[data-quick-open-panel]').classes())
      .toContain('max-h-[min(520px,calc(100vh-48px))]')
    expect(wrapper.get('[data-quick-open-panel]').classes()).toContain('max-w-[760px]')
    expect(wrapper.get('[data-quick-open]').classes()).toContain('pt-6')
  })

  it('keeps keyboard selection scrolled into view', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const wrapper = render()
    await wrapper.get('[data-quick-open-input]').trigger('keydown.down')
    await flushPromises()
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    scroll.mockRestore()
  })

  it('explains an empty project history and points to global search', async () => {
    const wrapper = render(true, {
      props: { history: [{ ...history[0], inCurrentWorkspace: false }] },
    })
    await wrapper.get('[data-quick-open-input]').setValue('h:')
    expect(wrapper.text()).toContain('No closed sessions in this project. Type to search all projects.')
  })

  it('enters a focused new activity subview and returns without closing', async () => {
    const wrapper = render()

    await wrapper.get('[data-quick-open-type="new-activity-enter"]').trigger('click')

    expect(wrapper.get('[data-quick-open-type="new-activity"]').text()).toContain('Codex')
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-type="file"]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-type="history"]').exists()).toBe(false)
    expect(wrapper.get('[data-quick-open-input]').attributes()).toMatchObject({
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      writingsuggestions: 'false',
      spellcheck: 'false',
    })
    expect(wrapper.emitted('activate')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.get('[data-quick-open-back]').trigger('click')
    expect(wrapper.get('[data-quick-open-type="new-activity-enter"]').exists()).toBe(true)
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(true)
  })

  it('opens directly in New activity with the current CLI selected', async () => {
    const wrapper = render(true, {
      props: {
        initialView: 'new-activity',
        preferredTargetId: 'preset:codex',
        newActivity: [
          { id: 'preset:terminal', title: 'Terminal', icon: 'terminal' },
          ...launchers,
        ],
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-quick-open-type="new-activity-enter"]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(false)
    expect(wrapper.get('[data-quick-open-key="new:preset:codex"]').attributes('aria-selected'))
      .toBe('true')

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'new-activity',
      targetId: 'preset:codex',
    })
  })

  it('uses Escape as Back inside New activity, then closes from the root', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-type="new-activity-enter"]').trigger('click')

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[data-quick-open-type="new-activity-enter"]').exists()).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('starts the selected source from the focused New activity subview', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-type="new-activity-enter"]').trigger('click')

    await wrapper.get('[data-quick-open-type="new-activity"]').trigger('click')

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'new-activity',
      targetId: 'preset:codex',
    })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('exposes one keyboard-contained dialog with combobox and listbox semantics', async () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const wrapper = render(false, { attachTo: document.body })

    await wrapper.setProps({ open: true })
    await flushPromises()
    const input = wrapper.get('[data-quick-open-input]')
    expect(wrapper.get('[data-quick-open]').attributes('role')).toBe('dialog')
    expect(wrapper.get('[data-quick-open]').attributes('aria-modal')).toBe('true')
    expect(input.attributes('role')).toBe('combobox')
    expect(input.attributes('aria-controls')).toBe('quick-open-results')
    expect(wrapper.get('#quick-open-results').attributes('role')).toBe('listbox')
    expect(document.activeElement).toBe(input.element)

    await input.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('[data-quick-open-row]').element)
    await wrapper.get('[data-quick-open-row]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('[data-quick-open-new-tab]').element)
    input.element.focus()
    await input.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(wrapper.findAll('[data-quick-open-chord]').at(-1).element)
    await wrapper.findAll('[data-quick-open-chord]').at(-1).trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(input.element)

    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(previous)
    wrapper.unmount()
    previous.remove()
  })

  it('uses scopes and emits the selected typed action', async () => {
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')

    await input.setValue('f:a')
    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('Files')
    expect(wrapper.findAll('[data-quick-open-type]').map(row => row.attributes('data-quick-open-type')))
      .toEqual(['file'])
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'file',
      path: '/w/a.md',
      verb: 'Open in Editor',
    })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('retains every matching group while typing and labels its prefix', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-input]').setValue('codex')

    expect(wrapper.findAll('[data-quick-open-type]').map(row => row.attributes('data-quick-open-type')))
      .toEqual(['new-activity', 'history'])
    expect(wrapper.get('[data-quick-open-group="New activity"]').text()).toContain('n:')
    expect(wrapper.get('[data-quick-open-group="History"]').text()).toContain('h:')
  })

  it('switches a project directly from p: results', async () => {
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')
    await input.setValue('p:other')

    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('Projects')
    expect(wrapper.findAll('[data-quick-open-type]').map(row => row.attributes('data-quick-open-type')))
      .toEqual(['project'])
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'project',
      path: '/work/other-project',
    })
  })

  it('opens all recent projects with the cursor after the prefix without waiting for file search', async () => {
    const files = useWorkspaceFilesStore()
    const search = vi.spyOn(files, 'setQuery').mockImplementation(() => new Promise(() => {}))
    const recent = Array.from({ length: 8 }, (_, index) => ({ name: `Project ${index}`, path: `/work/project-${index}` }))
    const wrapper = render(true, {
      attachTo: document.body,
      props: { initialView: 'projects', projects: [projects[0], ...recent] },
    })
    await flushPromises()
    const input = wrapper.get('[data-quick-open-input]')
    expect(document.activeElement).toBe(input.element)
    expect(input.element.value).toBe('p: ')
    expect(input.element.selectionStart).toBe(3)
    expect(input.element.selectionEnd).toBe(3)
    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('Projects')
    expect(wrapper.findAll('[data-quick-open-row]').map(row => row.attributes('data-quick-open-key'))).toEqual([
      ...recent.map(project => `project:${project.path}`), 'project:open', 'project:create',
    ])
    expect(wrapper.get('[aria-selected="true"]').attributes('data-quick-open-key')).toBe('project:/work/project-0')
    expect(search).not.toHaveBeenCalled()
    expect(activityApi.searchHistory).not.toHaveBeenCalled()

    // Text entered at the initial cursor must retain the project filter.
    input.element.setRangeText('Project 7', input.element.selectionStart, input.element.selectionEnd, 'end')
    await input.trigger('input')
    expect(input.element.value).toBe('p: Project 7')
    expect(wrapper.findAll('[data-quick-open-row]')).toHaveLength(1)
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('activate')).toBeUndefined()
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('activate')[0][0]).toMatchObject({ type: 'project', path: '/work/project-7' })
    search.mockRestore()
  })

  it('clears the project scope and resets the query for each entry point', async () => {
    const wrapper = render(true, { props: { initialView: 'projects' } })
    await flushPromises()
    await wrapper.get('[data-quick-open-input]').setValue('p: missing')
    expect(wrapper.text()).toContain('No matching projects.')
    await wrapper.get('[data-quick-open-input]').setValue('')
    expect(wrapper.find('[data-quick-open-scope]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(true)
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    expect(wrapper.get('[data-quick-open-input]').element.value).toBe('p: ')
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true, initialView: 'root' })
    expect(wrapper.get('[data-quick-open-input]').element.value).toBe('')
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(true)
  })

  it.each(['Enter', 'Escape', 'ArrowDown'])('leaves %s to text composition in project search', async key => {
    const wrapper = render(true, { attachTo: document.body, props: { initialView: 'projects' } })
    await flushPromises()
    const input = wrapper.get('[data-quick-open-input]').element
    const selected = input.getAttribute('aria-activedescendant')
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key, ...composition, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      await flushPromises()
      expect(event.defaultPrevented).toBe(false)
      expect(wrapper.emitted('activate')).toBeUndefined()
      expect(wrapper.emitted('close')).toBeUndefined()
      expect(input.getAttribute('aria-activedescendant')).toBe(selected)
    }
    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('activate')[0][0]).toMatchObject({ type: 'project', path: '/work/other-project' })
  })

  it('uses h: for closed history rather than current activities', async () => {
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')

    await input.setValue('h:')

    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('History')
    expect(wrapper.findAll('[data-quick-open-type]').map(row => row.attributes('data-quick-open-type')))
      .toEqual(['history'])
    expect(wrapper.get('[data-quick-open-detail]').text()).toBe('/w')
  })

  it('opens an Activity whose workspace is not available from a:', async () => {
    const wrapper = render(true, { props: { activities: unavailableActivities } })
    const input = wrapper.get('[data-quick-open-input]')

    await input.setValue('a:release')

    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('Activities')
    expect(wrapper.get('[data-quick-open-type="activity"]').text())
      .toContain('workspace not found')
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'activity',
      activityId: 'agent:orphaned',
    })
  })

  it('loads recent transcript context when browsing History without a search term', async () => {
    vi.useFakeTimers()
    try {
      activityApi.searchHistory.mockResolvedValue([{
        activityId: 'agent:closed',
        snippet: 'Implemented richer history rows and verified restore.',
      }])
      const wrapper = render()
      await wrapper.get('[data-quick-open-input]').setValue('h:')

      await vi.advanceTimersByTimeAsync(140)
      await flushPromises()

      expect(activityApi.searchHistory).toHaveBeenCalledWith('', 30)
      expect(wrapper.get('[data-quick-open-snippet]').text())
        .toContain('richer history rows')
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes on Escape or backdrop press', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    await wrapper.get('[data-quick-open-backdrop]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('cancels delayed file and history queries when it closes', async () => {
    vi.useFakeTimers()
    try {
      const filter = vi.mocked(
        (await import('../../services/fileIndex.js')).filterIndexedFiles,
      )
      filter.mockClear()
      const wrapper = render()
      await wrapper.get('[data-quick-open-input]').setValue('sidebar')
      await wrapper.setProps({ open: false })
      await vi.advanceTimersByTimeAsync(400)

      expect(filter).not.toHaveBeenCalled()
      expect(activityApi.searchHistory).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces file and lazy history search at roughly 130ms', async () => {
    vi.useFakeTimers()
    try {
      const filter = vi.mocked(
        (await import('../../services/fileIndex.js')).filterIndexedFiles,
      )
      filter.mockClear()
      filter.mockResolvedValue([])
      activityApi.searchHistory.mockResolvedValue([{
        activityId: 'agent:closed',
        snippet: 'changed sidebar ordering',
      }])
      const wrapper = render()
      await wrapper.get('[data-quick-open-input]').setValue('sidebar')

      await vi.advanceTimersByTimeAsync(100)
      expect(filter).not.toHaveBeenCalled()
      expect(activityApi.searchHistory).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(40)
      await flushPromises()
      expect(filter).toHaveBeenCalledWith('sidebar', 250)
      expect(activityApi.searchHistory).toHaveBeenCalledWith('sidebar', 30)
      expect(wrapper.get('[data-quick-open-type="history"] [data-quick-open-snippet]').text())
        .toContain('sidebar ordering')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps file-scope keyboard selection inside the rendered 100-result bound', async () => {
    const files = useWorkspaceFilesStore()
    files.files = Array.from({ length: 101 }, (_, index) => ({
      path: `/w/${index}.md`,
      name: `${index}.md`,
      relativePath: `${index}.md`,
    }))
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')
    await input.setValue('f:')

    expect(wrapper.findAll('[data-quick-open-type="file"]')).toHaveLength(100)
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('activate')[0][0]).toMatchObject({
      type: 'file',
      path: '/w/99.md',
    })
  })

  it('does not render while closed', () => {
    expect(render(false).find('[data-quick-open]').exists()).toBe(false)
  })
})
