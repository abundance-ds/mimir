import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { syntaxTree } from '@codemirror/language'
import {
  loadAppData,
  saveAppData,
} from '../../services/appsCatalog.js'
import TodayApp from './TodayApp.vue'

vi.mock('../../services/appsCatalog.js', () => ({
  loadAppData: vi.fn(),
  saveAppData: vi.fn(),
}))

const app = {
  id: 'scratch',
  title: 'Today',
  tools: [],
}

describe('TodayApp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(loadAppData).mockReset().mockResolvedValue(JSON.stringify({
      version: 1,
      text: 'Ship the focused review flow',
      updatedAt: '2026-07-25T10:00:00.000Z',
    }))
    vi.mocked(saveAppData).mockReset().mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function render() {
    return mount(TodayApp, {
      props: {
        app,
        active: true,
        instanceId: 'app:scratch',
      },
    })
  }

  function view(wrapper) {
    return wrapper.vm.getEditorView()
  }

  async function setEditorText(wrapper, value) {
    const editor = view(wrapper)
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: value,
      },
    })
    await wrapper.vm.$nextTick()
  }

  it('restores the previous durable priority', async () => {
    const wrapper = render()
    await flushPromises()

    expect(view(wrapper).state.doc.toString()).toBe('Ship the focused review flow')
  })

  it('exposes the unsaved live priority to mimir_state', async () => {
    const wrapper = render()
    await flushPromises()
    await setEditorText(wrapper, 'Unsaved but current')

    expect(wrapper.vm.todayState()).toEqual({
      text: 'Unsaved but current',
      loading: false,
      dirty: true,
      live: true,
    })
    expect(saveAppData).not.toHaveBeenCalled()
  })

  it('debounces durable autosave and keeps the save state honest', async () => {
    const wrapper = render()
    await flushPromises()

    await setEditorText(wrapper, 'Finish the priority card')
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Unsaved')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(1)
    const [appId, key, raw] = saveAppData.mock.calls[0]
    expect([appId, key]).toEqual(['scratch', 'scratch'])
    expect(JSON.parse(raw)).toMatchObject({ version: 1, text: 'Finish the priority card' })
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Saved')
  })

  it('keeps Select All inside the priority editor', async () => {
    const wrapper = render()
    await flushPromises()
    const editor = view(wrapper)
    editor.dispatch({ selection: { anchor: 5 } })

    await wrapper.get('.cm-content').trigger('keydown', { key: 'a', metaKey: true })

    expect(editor.state.selection.main.from).toBe(0)
    expect(editor.state.selection.main.to).toBe(editor.state.doc.length)
  })

  it('parses Markdown for source-level syntax highlighting without preview rendering', async () => {
    const wrapper = render()
    await flushPromises()
    await setEditorText(wrapper, '# Focus\n\n**Ship it** with [notes](./notes.md)')

    const tree = syntaxTree(view(wrapper).state).toString()
    expect(tree).toContain('ATXHeading1')
    expect(tree).toContain('StrongEmphasis')
    expect(tree).toContain('Link')
    expect(wrapper.find('h1').exists()).toBe(false)
  })

  it('keeps a failed save recoverable without losing the draft', async () => {
    vi.mocked(saveAppData)
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValueOnce()
    const wrapper = render()
    await flushPromises()

    await setEditorText(wrapper, 'Keep this exact draft')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(wrapper.get('[data-today-error]').text()).toContain('disk busy')
    expect(view(wrapper).state.doc.toString()).toBe('Keep this exact draft')

    await wrapper.get('[data-today-error] button').trigger('click')
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-today-error]').exists()).toBe(false)
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Saved')
  })

  it('unmounts cleanly', async () => {
    const wrapper = render()
    await flushPromises()

    wrapper.unmount()
    await flushPromises()
    expect(wrapper.exists()).toBe(false)
  })
})
