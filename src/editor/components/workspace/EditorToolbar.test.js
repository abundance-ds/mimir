import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EditorToolbar from './EditorToolbar.vue'

function mountToolbar(props = {}) {
  return mount(EditorToolbar, { props })
}

function btnByTitle(wrapper, title) {
  return wrapper.findAll('button').find(b => b.attributes('title') === title)
}

function commentBtn(wrapper) {
  return wrapper.find('[data-toolbar-action="comment"]')
}

describe('EditorToolbar', () => {
  it('renders all 15 toolbar buttons (14 format + 1 comment)', () => {
    const w = mountToolbar()
    const btns = w.findAll('button.toolbar-btn')
    expect(btns).toHaveLength(15)
  })

  it('emits format event with correct name on click', async () => {
    const w = mountToolbar()
    const boldBtn = btnByTitle(w, 'Bold (⇧⌘B)')
    expect(boldBtn).toBeTruthy()
    await boldBtn.trigger('click')
    expect(w.emitted('format')).toBeTruthy()
    expect(w.emitted('format')[0]).toEqual(['bold'])
  })

  it('highlights active format buttons', () => {
    const w = mountToolbar({ activeFormats: ['bold', 'italic'] })
    const boldBtn = btnByTitle(w, 'Bold (⇧⌘B)')
    const italicBtn = btnByTitle(w, 'Italic (⌘I)')
    const h1Btn = btnByTitle(w, 'Heading 1')
    expect(boldBtn.classes()).toContain('toolbar-active')
    expect(italicBtn.classes()).toContain('toolbar-active')
    expect(h1Btn.classes()).not.toContain('toolbar-active')
  })

  it('emits correct format names for representative buttons', async () => {
    const w = mountToolbar()
    const cases = [
      ['Heading 1', 'heading-1'],
      ['Bullet List (⇧⌘8)', 'bullet-list'],
      ['Blockquote (⇧⌘.)', 'blockquote'],
    ]
    for (const [title, expected] of cases) {
      const btn = btnByTitle(w, title)
      expect(btn, `button titled "${title}" not found`).toBeTruthy()
      await btn.trigger('click')
    }
    const emitted = w.emitted('format')
    expect(emitted).toHaveLength(3)
    expect(emitted[0]).toEqual(['heading-1'])
    expect(emitted[1]).toEqual(['bullet-list'])
    expect(emitted[2]).toEqual(['blockquote'])
  })

  it('no buttons highlighted when activeFormats is empty', () => {
    const w = mountToolbar()
    const activeButtons = w.findAll('button.toolbar-active')
    expect(activeButtons).toHaveLength(0)
  })

  // --- Add Comment button behavior ---

  it('Add Comment button renders as icon', () => {
    const w = mountToolbar()
    const btn = commentBtn(w)
    expect(btn.find('svg').exists()).toBe(true)
  })

  it('Add Comment button is disabled when hasSelection is false', () => {
    const w = mountToolbar({ hasSelection: false })
    const btn = commentBtn(w)
    expect(btn.classes()).toContain('toolbar-disabled')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('Add Comment button is enabled when hasSelection is true', () => {
    const w = mountToolbar({ hasSelection: true })
    const btn = commentBtn(w)
    expect(btn.classes()).not.toContain('toolbar-disabled')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('Add Comment button does NOT emit comment when hasSelection is false', async () => {
    const w = mountToolbar({ hasSelection: false })
    const btn = commentBtn(w)
    await btn.trigger('click')
    expect(w.emitted('comment')).toBeFalsy()
  })

  it('Add Comment button emits comment when hasSelection is true', async () => {
    const w = mountToolbar({ hasSelection: true })
    const btn = commentBtn(w)
    await btn.trigger('click')
    expect(w.emitted('comment')).toBeTruthy()
    expect(w.emitted('comment')).toHaveLength(1)
  })

  it('shows a compact previous, count, and next comment navigator', async () => {
    const w = mountToolbar({ hasSelection: true, commentCount: 3 })
    expect(commentBtn(w).text()).toContain('Comment')
    expect(w.find('.comment-nav-count').text()).toBe('3')
    expect(w.find('.comment-nav').attributes('aria-label')).toBe('3 visible comments')

    await btnByTitle(w, 'Previous comment').trigger('click')
    await btnByTitle(w, 'Next comment').trigger('click')
    expect(w.emitted('navigate-comment')).toEqual([['previous'], ['next']])
    expect(w.findAll('button.toolbar-btn')).toHaveLength(17)
  })

})
