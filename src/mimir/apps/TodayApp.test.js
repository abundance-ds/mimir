import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { syntaxTree } from '@codemirror/language'
import { loadAppData, saveAppData } from '../../services/appsCatalog.js'
import { archiveTodayEntry, loadTodayEntry } from './todayJournal.js'
import TodayApp from './TodayApp.vue'

vi.mock('../../services/appsCatalog.js', () => ({
  loadAppData: vi.fn(),
  saveAppData: vi.fn(),
}))

vi.mock('./todayJournal.js', () => ({
  archiveTodayEntry: vi.fn(),
  loadTodayEntry: vi.fn(),
}))

const app = {
  id: 'scratch',
  title: 'Today',
  tools: [],
}

describe('TodayApp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0))
    vi.mocked(loadAppData).mockReset().mockResolvedValue(JSON.stringify({
      version: 3,
      date: '2026-08-15',
      text: 'Ship the focused review flow',
      updatedAt: '2026-08-15T10:00:00.000Z',
      previous: null,
      archiveQueue: [],
      tomorrow: null,
    }))
    vi.mocked(saveAppData).mockReset().mockResolvedValue()
    vi.mocked(archiveTodayEntry).mockReset().mockResolvedValue({ id: 'journal-2026-08' })
    vi.mocked(loadTodayEntry).mockReset().mockResolvedValue(null)
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

  it('uses one fixed-width footer instrument without a second Today title', async () => {
    const wrapper = render()
    await flushPromises()

    expect(view(wrapper).state.doc.toString()).toBe('Ship the focused review flow')
    expect(wrapper.get('[data-today-date-nav]').text()).toContain('Sat 15 Aug')
    expect(wrapper.find('[data-today-datebar]').exists()).toBe(false)
    expect(wrapper.get('[data-today-date-nav]').classes()).not.toContain('border-l')
    expect(wrapper.get('[data-today-date-nav] time').classes()).toContain('w-[104px]')
  })

  it('exposes live Today content as optional artifact context', async () => {
    const wrapper = render()
    await flushPromises()
    await setEditorText(wrapper, 'Unsaved but current')

    expect(wrapper.vm.todayState()).toEqual({
      artifactType: 'today',
      date: '2026-08-15',
      mediaType: 'text/markdown',
      content: 'Unsaved but current',
      updatedAt: '2026-08-15T10:00:00.000Z',
      loading: false,
      dirty: true,
      live: true,
    })
    expect(saveAppData).not.toHaveBeenCalled()
  })

  it('debounces version 3 durable autosave', async () => {
    const wrapper = render()
    await flushPromises()

    await setEditorText(wrapper, 'Finish the journal flow')
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Unsaved')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(1)
    const [appId, key, raw] = saveAppData.mock.calls[0]
    expect([appId, key]).toEqual(['scratch', 'scratch'])
    expect(JSON.parse(raw)).toMatchObject({
      version: 3,
      date: '2026-08-15',
      text: 'Finish the journal flow',
      archiveQueue: [],
      tomorrow: null,
    })
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Saved')
  })

  it('uses Tab to indent a task instead of moving focus', async () => {
    const wrapper = render()
    await flushPromises()
    await setEditorText(wrapper, '- [ ] Parent\n- [ ] Child')
    const editor = view(wrapper)
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })

    await wrapper.get('.cm-content').trigger('keydown', { key: 'Tab' })

    expect(editor.state.doc.toString()).toBe('- [ ] Parent\n  - [ ] Child')

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: 'Plain paragraph' },
      selection: { anchor: 'Plain paragraph'.length },
    })
    await wrapper.get('.cm-content').trigger('keydown', { key: 'Tab' })
    expect(editor.state.doc.toString()).toBe('  Plain paragraph')
  })

  it('edits and autosaves one Tomorrow draft without changing Today context', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[aria-label="View next day"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-today-date-nav] time').attributes('datetime')).toBe('2026-08-16')
    expect(wrapper.get('.cm-content').attributes('aria-label')).toContain('Tomorrow')
    expect(wrapper.get('.cm-content').attributes('contenteditable')).toBe('true')

    await setEditorText(wrapper, 'Prepare the opening note.')
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Unsaved')
    expect(wrapper.vm.todayState()).toMatchObject({
      date: '2026-08-15',
      content: 'Ship the focused review flow',
      dirty: false,
    })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(JSON.parse(saveAppData.mock.calls.at(-1)[2])).toMatchObject({
      version: 3,
      text: 'Ship the focused review flow',
      tomorrow: {
        date: '2026-08-16',
        text: 'Prepare the opening note.',
      },
    })

    await wrapper.get('[aria-label="Return to current day"]').trigger('click')
    expect(view(wrapper).state.doc.toString()).toBe('Ship the focused review flow')
    expect(wrapper.get('[data-today-save-state]').text()).toBe('')
  })

  it('rolls over the full prior day and carries nested task blocks', async () => {
    vi.mocked(loadAppData).mockResolvedValue(JSON.stringify({
      version: 3,
      date: '2026-08-14',
      text: [
        '# Friday',
        '- [ ] Open parent',
        '  - [x] Finished child',
        '  - [ ] Open child',
        '- [x] Finished parent',
        '  - [ ] Still open',
      ].join('\n'),
      updatedAt: '2026-08-14T18:00:00.000Z',
    }))
    const wrapper = render()
    await flushPromises()

    expect(archiveTodayEntry).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-08-14',
      text: expect.stringContaining('# Friday'),
    }))
    expect(view(wrapper).state.doc.toString()).toBe('')
    expect(wrapper.get('[data-today-rollover]').text()).toContain('2 unfinished items')

    await wrapper.get('[data-today-rollover] button:nth-of-type(1)').trigger('click')

    expect(view(wrapper).state.doc.toString()).toBe([
      '- [ ] Open parent',
      '  - [x] Finished child',
      '  - [ ] Open child',
      '',
      '- [ ] Still open',
    ].join('\n'))
    expect(wrapper.find('[data-today-rollover]').exists()).toBe(false)
  })

  it('promotes Tomorrow unchanged and appends carried items below it', async () => {
    vi.mocked(loadAppData).mockResolvedValue(JSON.stringify({
      version: 3,
      date: '2026-08-14',
      text: '- [ ] Carry this task',
      updatedAt: '2026-08-14T18:00:00.000Z',
      tomorrow: {
        date: '2026-08-15',
        text: 'Prepared first.\n- [ ] Tomorrow task',
        updatedAt: '2026-08-14T19:00:00.000Z',
      },
    }))
    const wrapper = render()
    await flushPromises()

    expect(view(wrapper).state.doc.toString()).toBe('Prepared first.\n- [ ] Tomorrow task')
    expect(wrapper.get('[data-today-rollover]').text()).toContain('1 unfinished item')

    await wrapper.get('[data-today-rollover] button:nth-of-type(1)').trigger('click')

    expect(view(wrapper).state.doc.toString()).toBe([
      'Prepared first.',
      '- [ ] Tomorrow task',
      '',
      '- [ ] Carry this task',
    ].join('\n'))
  })

  it('archives a missed Tomorrow draft under its intended date', async () => {
    vi.mocked(loadAppData).mockResolvedValue(JSON.stringify({
      version: 3,
      date: '2026-08-13',
      text: 'Thursday note.',
      tomorrow: {
        date: '2026-08-14',
        text: 'Friday draft.',
      },
    }))
    const wrapper = render()
    await flushPromises()

    expect(archiveTodayEntry).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-08-13',
      text: 'Thursday note.',
    }))
    expect(archiveTodayEntry).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-08-14',
      text: 'Friday draft.',
    }))
    expect(view(wrapper).state.doc.toString()).toBe('')
  })

  it('looks back in the same read-only editor and keeps Today context current', async () => {
    vi.mocked(loadTodayEntry).mockResolvedValue('- [x] Yesterday was archived')
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[aria-label="View previous day"]').trigger('click')
    await flushPromises()

    expect(loadTodayEntry).toHaveBeenCalledWith('2026-08-14')
    expect(view(wrapper).state.doc.toString()).toBe('- [x] Yesterday was archived')
    expect(wrapper.get('[data-today-date-nav] time').attributes('datetime')).toBe('2026-08-14')
    expect(wrapper.get('.cm-content').attributes('contenteditable')).toBe('false')
    expect(wrapper.vm.todayState().content).toBe('Ship the focused review flow')

    await wrapper.get('[aria-label="Return to current day"]').trigger('click')
    expect(view(wrapper).state.doc.toString()).toBe('Ship the focused review flow')
  })

  it('keeps Select All inside the Today editor', async () => {
    const wrapper = render()
    await flushPromises()
    const editor = view(wrapper)
    editor.dispatch({ selection: { anchor: 5 } })

    await wrapper.get('.cm-content').trigger('keydown', { key: 'a', metaKey: true })

    expect(editor.state.selection.main.from).toBe(0)
    expect(editor.state.selection.main.to).toBe(editor.state.doc.length)
  })

  it('parses Markdown without preview rendering', async () => {
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
  })

  it('unmounts cleanly', async () => {
    const wrapper = render()
    await flushPromises()

    wrapper.unmount()
    await flushPromises()
    expect(wrapper.exists()).toBe(false)
  })
})
