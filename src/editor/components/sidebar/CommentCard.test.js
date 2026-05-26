import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CommentCard from './CommentCard.vue'

function makeComment(overrides = {}) {
  return {
    id: 'test-1',
    filePath: '/test.md',
    range: { from: 10, to: 20 },
    anchorText: 'selected text',
    author: 'user',
    text: 'This needs work',
    severity: null,
    replies: [],
    proposedEdit: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function mountCard(props = {}) {
  return mount(CommentCard, {
    props: { comment: makeComment(), ...props },
    global: { stubs: { Teleport: true } },
  })
}

describe('CommentCard', () => {
  it('collapsed: shows author, clamped body, no reply input', () => {
    const w = mountCard()
    expect(w.text()).toContain('You')
    expect(w.text()).toContain('This needs work')
    expect(w.find('.line-clamp-2').exists()).toBe(true)
    expect(w.find('textarea[placeholder="Reply..."]').exists()).toBe(false)
  })

  it('collapsed: done button exists but hidden (opacity-0), visible on group-hover', () => {
    const w = mountCard()
    const doneBtn = w.find('button[title="Done — remove comment"]')
    expect(doneBtn.exists()).toBe(true)
    expect(doneBtn.classes()).toContain('opacity-0')
    expect(doneBtn.classes()).toContain('group-hover:opacity-100')
  })

  it('collapsed: shows reply count indicator when replies exist', () => {
    const w = mountCard({
      comment: makeComment({ replies: [{ id: 'r1', author: 'ai', text: 'Done', ts: new Date().toISOString() }] }),
    })
    expect(w.text()).toContain('1')
  })

  it('expanded: shows full body, done button, context menu, reply input', () => {
    const w = mountCard({ active: true })
    expect(w.find('.line-clamp-2').exists()).toBe(false)
    expect(w.find('button[title="Done — remove comment"]').exists()).toBe(true)
    expect(w.find('button[title="More actions"]').exists()).toBe(true)
    expect(w.find('textarea[placeholder="Reply..."]').exists()).toBe(true)
  })

  it('expanded: done button always visible (no opacity-0)', () => {
    const w = mountCard({ active: true })
    const doneBtn = w.find('button[title="Done — remove comment"]')
    expect(doneBtn.classes()).not.toContain('opacity-0')
  })

  it('expanded: done button emits delete', async () => {
    const w = mountCard({ active: true })
    await w.find('button[title="Done — remove comment"]').trigger('click')
    expect(w.emitted('delete')).toBeTruthy()
    expect(w.emitted('delete')[0]).toEqual(['test-1'])
  })

  it('expanded: shows replies when present', () => {
    const w = mountCard({
      comment: makeComment({
        replies: [{ id: 'r1', author: 'ai', text: 'I fixed it', ts: new Date().toISOString() }],
      }),
      active: true,
    })
    expect(w.text()).toContain('I fixed it')
    expect(w.text()).toContain('Shoulders')
  })

  it('expanded: reply input always visible without needing a Reply button click', () => {
    const w = mountCard({ active: true })
    expect(w.find('textarea[placeholder="Reply..."]').exists()).toBe(true)
    expect(w.findAll('button').some(b => b.text() === 'Reply' && !b.attributes('disabled'))).toBe(false)
  })

  it('editing: autoEdit on empty comment shows textarea', () => {
    const w = mountCard({
      comment: makeComment({ text: '' }),
      active: true,
      autoEdit: true,
    })
    expect(w.find('textarea[placeholder="Write a comment..."]').exists()).toBe(true)
    expect(w.text()).toContain('Save')
    expect(w.text()).toContain('Cancel')
  })

  it('deactivating resets editing state', async () => {
    const w = mountCard({ active: true })
    await w.setProps({ active: false })
    expect(w.find('textarea[placeholder="Reply..."]').exists()).toBe(false)
  })

  it('emits delete when Escape pressed on empty draft', async () => {
    const w = mountCard({
      comment: makeComment({ text: '' }),
      active: true,
      autoEdit: true,
    })
    const textarea = w.find('textarea')
    await textarea.trigger('keydown', { key: 'Escape' })
    expect(w.emitted('delete')).toBeTruthy()
  })

  it('collapsed: clicking done emits delete without needing to activate first', async () => {
    const w = mountCard()
    await w.find('button[title="Done — remove comment"]').trigger('click')
    expect(w.emitted('delete')).toBeTruthy()
    expect(w.emitted('delete')[0]).toEqual(['test-1'])
  })
})
