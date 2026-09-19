import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import ProjectHome from './ProjectHome.vue'
import { projectAttention } from './projectAttention.js'

let wrapper, items
const project = { id: 'atlas', kind: 'project', title: 'Atlas' }
const markdown = '**Deliverable:** Evidence package.\n\n## Key resources\n\n- [Protocol](https://example.org/protocol.pdf)\n- [Evidence table](evidence/table.xlsx)\n- [Analysis plan][plan]\n\n[plan]: mimir://graph/analysis-plan\n\n## Context\n\nKeep this text too.'
const task = (id, extra = {}) => ({ id, title: id, kind: 'issue', projectId: 'atlas', status: 'review', assigneeId: 'anna', ...extra })
function render(props = {}) {
  wrapper = mount(ProjectHome, { attachTo: document.body, props: { project, scopeIds: ['team'], modelValue: markdown,
    viewState: { note: null }, 'onUpdate:modelValue': modelValue => wrapper.setProps({ modelValue }), ...props } })
  return wrapper
}
beforeEach(() => {
  items = [task('Review extraction')]
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'graph_query') return { items, total: items.length, graphRevision: 1 }
    if (command === 'graph_link_targets') return args.ids.map(id => ({ id, status: 'resolved', title: id === 'anna' ? 'Anna Berg' : 'Analysis plan' }))
    return []
  })
})
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Project home', () => {
  it('opens an editable canvas with standard live preview and direct task actions', async () => {
    render()
    await flushPromises()
    expect(wrapper.get('.cm-content').attributes('contenteditable')).toBe('true')
    expect(wrapper.text()).toContain('Keep this text too.')
    expect(wrapper.find('[data-graph-markdown-editor]').exists()).toBe(true)
    expect(wrapper.find('.graph-note-tools').exists()).toBe(false)
    expect(wrapper.findAll('button').map(button => button.text())).not.toContain('Edit canvas')
    expect(wrapper.get('.project-attention-row').text()).toContain('Anna Berg')
    await wrapper.get('.project-attention-row').trigger('click')
    expect(wrapper.emitted('openNode').at(-1)).toEqual(['Review extraction'])
    await wrapper.get('[data-graph-control="project-open-work"]').trigger('click')
    expect(wrapper.emitted('openWork')).toEqual([[project]])
  })

  it('accepts typing and undo on an empty canvas without an edit step or purpose prompt', async () => {
    items = []
    render({ modelValue: '', project: { ...project, body: 'Stable agent context' } })
    await flushPromises()
    const view = EditorView.findFromDOM(wrapper.get('.cm-editor').element)
    expect(wrapper.find('.cm-placeholder').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/What matters|Start the canvas|Edit canvas|Done/)
    expect(wrapper.get('.project-home-project-context').attributes('open')).toBeUndefined()
    view.dispatch({ changes: { from: 0, insert: 'A joke for tomorrow' } })
    await flushPromises()
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['A joke for tomorrow'])
    undo(view)
    await flushPromises()
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([''])
    expect(wrapper.emitted('openNode')).toBeUndefined()
  })

  it('shows loading failures with Retry and keeps the authored page visible', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Index unavailable'))
    render()
    await flushPromises()
    expect(wrapper.text()).toContain('Index unavailable')
    expect(wrapper.text()).not.toContain('No waiting')
    expect(wrapper.get('.cm-content').text()).toContain('Evidence table')
    await wrapper.get('[data-graph-control="project-work-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.project-attention-row').exists()).toBe(true)
  })

  it('keeps existing rows in place through a background refresh', async () => {
    items = [task('B'), task('C')]
    render()
    await flushPromises()
    const first = wrapper.get('.project-attention-row').element
    items = [task('A'), task('B'), task('C')]
    await wrapper.setProps({ graphRevision: 2 })
    await flushPromises()
    expect(wrapper.findAll('.project-attention-row strong').map(row => row.text())).toEqual(['B', 'C', 'A'])
    expect(wrapper.get('.project-attention-row').element).toBe(first)
  })

  it('updates due tasks and resolves their owners after the date changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-18T23:59:00'))
    items = [task('Tomorrow', { status: 'plan', dueDate: '2026-09-19' })]
    render()
    await flushPromises()
    expect(wrapper.find('.project-attention-row').exists()).toBe(false)
    vi.setSystemTime(new Date('2026-09-19T00:01:00'))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.get('.project-attention-row').text()).toContain('due today')
    expect(wrapper.get('.project-attention-row').text()).toContain('Anna Berg')
  })

  it('discards a late task query after changing Project', async () => {
    let finish
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render()
    items = [task('New project task', { projectId: 'beta' })]
    await wrapper.setProps({ project: { ...project, id: 'beta' } })
    await flushPromises()
    finish({ items: [task('Old project task')], total: 1, graphRevision: 1 })
    await flushPromises()
    expect(wrapper.findAll('.project-attention-row strong').map(row => row.text())).toEqual(['New project task'])
  })

  it('renders authored HTML as text and rejects executable links', async () => {
    render({ modelValue: '<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))\n\n- [x] Finished task\n\n| A | B |\n| - | - |\n| One | Two |' })
    await flushPromises()
    expect(wrapper.find('img[onerror]').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('.project-inline-link')).toHaveLength(0)
    expect(wrapper.text()).toContain('Finished task')
    expect(wrapper.find('table').exists()).toBe(true)
  })
})

describe('attention reasons', () => {
  it('uses saved task facts, excludes closed and snoozed work, and labels dates', () => {
    const rows = projectAttention([
      task('review'), task('waiting', { status: 'waiting', waitingFor: 'client' }),
      task('overdue', { status: 'plan', dueDate: '2026-09-17' }), task('today', { status: 'plan', dueDate: '2026-09-18' }),
      task('later', { status: 'plan', dueDate: '2026-09-30' }), task('done', { status: 'done', dueDate: '2026-09-01' }),
      task('cancelled', { status: 'cancelled' }), task('snoozed', { snoozeUntil: '2026-09-20' }),
    ], new Date('2026-09-18T12:00:00'))
    expect(rows.map(row => row.id)).toEqual(['overdue', 'waiting', 'today', 'review'])
    expect(rows[0].due.label).toBe('1d overdue')
    expect(rows[1].reason).toBe('Waiting for client')
  })
})
