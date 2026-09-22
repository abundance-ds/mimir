import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { commentsExtension, setActiveComment, setResolvedCommentsVisible } from './comments.js'
import { livePreviewExtension, setTableWidths } from './livePreview.js'
import { markdownLinkOpen } from './markdownLinks.js'
import { createPinia, setActivePinia } from 'pinia'
import { useCommentMutations } from '../composables/useCommentMutations.js'

const sample = 'Before\n\n| Who | Item | Monthly |\n| --- | --- | ---: |\n'
  + '| General | <comment id="a" text="Check price">**Workspace**</comment> and <comment id="b" text="Check plan">[GitHub](guide.md)</comment> | €58 |\n'
  + '| | <comment id="c" text="Seats">Slack</comment> | €75 |\n'
  + '| Paul | <comment id="d" text="Done" status="resolved">Codex</comment> | €220 |\n\nAfter'
const views = []
afterEach(() => { for (const view of views.splice(0)) view.destroy() })
function mount(doc = sample, fail = false) {
  let view
  const onOpenFile = vi.fn()
  setActivePinia(createPinia())
  const mutations = useCommentMutations({ value: { getView: () => view } })
  const action = vi.fn(({ type, id, text }) => {
    if (fail) return { ok: false, error: 'Save failed.' }
    if (type === 'reply') return mutations.addReply(id, text)
    return mutations[type]?.(id) || { ok: false, error: 'Unsupported action.' }
  })
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
      markdown({ base: markdownLanguage }),
      commentsExtension({ onCommentAction: action }),
      livePreviewExtension(() => true, () => '/work/readme.md', () => [], { resizableTables: () => true }),
      markdownLinkOpen({ selector: '.cm-lp-link', preserveRenderedLink: true, onOpenFile }),
    ] }),
  })
  views.push(view)
  return { view, action, onOpenFile }
}
const query = (view, selector) => view.dom.querySelector(selector)
const thread = (view, id) => query(view, `[data-thread-id="${id}"]`)
const clickAction = (view, id, action) => thread(view, id).querySelector(`[data-comment-action="${action}"]`).click()

describe('table comment discussions', () => {
  it('counts threads per cell and table, opens without source, and selects exact formatted anchors', () => {
    const { view } = mount()
    const initial = view.state.selection.main.head
    const markers = [...view.dom.querySelectorAll('.cm-table-comment-marker')].filter(el => !el.hidden)
    expect(markers.map(el => el.textContent)).toEqual(['2 comments', '1 comment'])
    expect(query(view, '.cm-table-comment-toggle').textContent).toBe('Comments (3)')
    expect(query(view, '.cm-table-comment-list').hidden).toBe(true)
    expect([...view.dom.querySelectorAll('.cm-table-comment-location')].map(el => el.textContent)).toEqual([
      'Item, row 1: Workspace', 'Item, row 1: GitHub', 'Item, row 2: Slack', 'Item, row 3: Codex',
    ])
    markers[0].click()
    expect(view.state.selection.main.head).toBe(initial)
    expect(query(view, 'table')).not.toBeNull()
    expect(query(view, '.cm-table-comment-list').hidden).toBe(false)
    expect(query(view, 'strong .cm-comment-range-active').textContent).toBe('Workspace')
    thread(view, 'b').querySelector('.cm-table-comment-location').click()
    expect(query(view, '.cm-lp-link .cm-comment-range-active').textContent).toBe('GitHub')
    expect(query(view, 'strong .cm-comment-range-active')).toBeNull()
    expect(view.dom.querySelectorAll('.cm-comment-block')).toHaveLength(4)
    expect(thread(view, 'd').hidden).toBe(true)
    query(view, '.cm-table-comment-toggle').click()
    expect(query(view, '.cm-table-comment-list').hidden).toBe(true)
    expect(markers[0].textContent).toBe('2 comments')
    expect(view.state.doc.toString()).toBe(sample)
  })

  it('preserves a reply draft and focus when selecting comments and resizing columns', () => {
    const { view } = mount()
    query(view, '.cm-table-comment-marker').click()
    thread(view, 'a').querySelector('.cm-comment-reply-trigger').click()
    const input = thread(view, 'a').querySelector('textarea')
    input.value = 'Keep this draft'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    view.dispatch({ effects: setActiveComment.of('b') })
    const from = view.state.doc.toString().indexOf('| Who')
    const to = view.state.doc.toString().indexOf('\n\nAfter')
    view.dispatch({ effects: setTableWidths.of({ from, to, widths: [120, 260, 120] }) })
    expect(thread(view, 'a').querySelector('textarea')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Keep this draft')
    expect(view.state.doc.toString()).toBe(sample)
  })

  it('replies, resolves, reopens, and deletes through existing actions without leaving preview', async () => {
    const { view, action } = mount()
    query(view, '.cm-table-comment-marker').click()
    thread(view, 'a').querySelector('.cm-comment-reply-trigger').click()
    const input = thread(view, 'a').querySelector('textarea')
    input.value = 'Confirmed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    clickAction(view, 'a', 'reply')
    await Promise.resolve()
    expect(action).toHaveBeenCalledWith({ type: 'reply', id: 'a', text: 'Confirmed' })
    expect(thread(view, 'a').textContent).toContain('Confirmed')
    expect(query(view, 'table')).not.toBeNull()
    clickAction(view, 'a', 'resolve')
    await Promise.resolve()
    expect(query(view, '.cm-table-comment-toggle').textContent).toBe('Comments (2)')
    query(view, '.cm-table-comment-resolved').click()
    expect(thread(view, 'a').hidden).toBe(false)
    expect(thread(view, 'd').hidden).toBe(false)
    clickAction(view, 'a', 'reopen')
    await Promise.resolve()
    expect(query(view, '.cm-table-comment-toggle').textContent).toBe('Comments (3)')
    clickAction(view, 'b', 'delete')
    await Promise.resolve()
    expect(thread(view, 'b')).toBeNull()
    expect(query(view, 'table').textContent).toContain('GitHub')
    expect(query(view, '.cm-table-comment-toggle').textContent).toBe('Comments (2)')
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('After')
  })


  it('keeps separate table lists independent and follows resolved visibility controls', () => {
    const second = '\n\n| Item |\n| --- |\n| <comment id="second" text="Other">Other table</comment> |\n\nEnd'
    const { view } = mount(sample + second)
    const panels = [...view.dom.querySelectorAll('.cm-table-comments')]
    expect(panels).toHaveLength(2)
    query(view, '.cm-table-comment-marker').click()
    expect(panels[0].querySelector('.cm-table-comment-list').hidden).toBe(false)
    expect(panels[1].querySelector('.cm-table-comment-list').hidden).toBe(true)
    view.dispatch({ effects: setResolvedCommentsVisible.of(true) })
    expect(thread(view, 'd').hidden).toBe(false)
    view.dispatch({ effects: setResolvedCommentsVisible.of(false) })
    expect(thread(view, 'd').hidden).toBe(true)
  })

  it('keeps the list open after deleting its first thread', async () => {
    const { view } = mount()
    query(view, '.cm-table-comment-marker').click()
    clickAction(view, 'a', 'delete')
    await Promise.resolve()
    expect(query(view, '.cm-table-comment-list').hidden).toBe(false)
    expect(thread(view, 'a')).toBeNull()
    expect(query(view, '.cm-table-comment-toggle').textContent).toBe('Comments (2)')
  })

  it('retains draft and error on a failed reply', async () => {
    const { view } = mount(sample, true)
    query(view, '.cm-table-comment-marker').click()
    thread(view, 'a').querySelector('.cm-comment-reply-trigger').click()
    const input = thread(view, 'a').querySelector('textarea')
    input.value = 'Retry this'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    clickAction(view, 'a', 'reply')
    await Promise.resolve()
    expect(input.value).toBe('Retry this')
    expect(thread(view, 'a').querySelector('.cm-comment-error').textContent).toBe('Save failed.')
    expect(view.state.doc.toString()).toBe(sample)
  })

  it('restores source comments on entry and keeps links usable in preview', () => {
    const { view, onOpenFile } = mount()
    const link = query(view, '.cm-lp-link')
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(onOpenFile).toHaveBeenCalledWith('guide.md')
    expect(query(view, 'table')).not.toBeNull()
    view.dispatch({ selection: { anchor: sample.indexOf('Workspace') } })
    expect(query(view, 'table')).toBeNull()
    expect(view.dom.querySelectorAll('.cm-comment-block')).toHaveLength(3)
    view.dispatch({ selection: { anchor: sample.length } })
    expect(query(view, 'table')).not.toBeNull()
    expect(view.dom.querySelectorAll('.cm-table-comments')).toHaveLength(1)
  })
})
