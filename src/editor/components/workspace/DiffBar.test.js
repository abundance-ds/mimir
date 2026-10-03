import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DiffBar from './DiffBar.vue'
import { useDiffStore } from '../../../stores/diff.js'

enableAutoUnmount(afterEach)
describe('DiffBar', () => {
  let diff
  beforeEach(() => {
    setActivePinia(createPinia())
    diff = useDiffStore()
    diff.activate({ original: 'old', modified: 'new' })
  })
  function mountBar() { return mount(DiffBar, { attachTo: document.body, global: { stubs: { Teleport: true } } }) }
  async function openActions(wrapper) { await wrapper.get('.review-menu-trigger').trigger('click') }

  it('uses one view selector and names the pending work', () => {
    const w = mountBar()
    expect(w.get('[role=combobox]').text()).toBe('Unified')
    expect(w.text()).toContain('1 change left')
    expect(w.get('.review-finish').attributes()).toHaveProperty('disabled')
  })

  it('selects Split, Original, and Result through the same view menu', async () => {
    const w = mountBar()
    for (const value of ['split', 'original', 'result', 'unified']) {
      await w.get('[role=combobox]').trigger('click')
      await w.get(`[data-graph-select-option=${value}]`).trigger('click')
      expect(diff.viewMode).toBe(['split', 'unified'].includes(value) ? 'diff' : value)
      expect(w.get('[role=combobox]').attributes('aria-expanded')).toBe('false')
    }
    expect(diff.layout).toBe('unified')
  })

  it.each(['accept', 'reject'])('stages %s remaining and requires Finish review', async action => {
    const w = mountBar()
    await openActions(w)
    const label = action === 'accept' ? 'Accept' : 'Reject'
    await w.findAll('[role=menuitem]').find(button => button.text().startsWith(label)).trigger('click')
    expect(diff.active).toBe(true)
    expect(diff.currentReview.result).toBe(action === 'accept' ? 'new' : 'old')
    expect(w.text()).toContain('Review complete')
    expect(w.emitted('finish')).toBeUndefined()
    await w.get('.review-finish').trigger('click')
    expect(w.emitted('finish')).toHaveLength(1)
  })

  it('offers Undo and Redo after the final decision', async () => {
    const w = mountBar()
    diff.decideRemainingChanges('accept')
    await w.vm.$nextTick()
    await w.get('[title="Undo review decision"]').trigger('click')
    expect(diff.pendingChanges).toBe(1)
    await openActions(w)
    await w.findAll('[role=menuitem]').find(button => button.text() === 'Redo review decision').trigger('click')
    expect(diff.canFinish).toBe(true)
  })

  it('navigates pending changes and returns from Result to the diff', async () => {
    diff.setViewMode('result')
    const w = mountBar()
    await w.get('[aria-label="Next change"]').trigger('click')
    expect(diff.viewMode).toBe('diff')
    expect(w.emitted('navigate-chunk')).toEqual([[0]])
  })

  it('names batch scope and applies the menu action to every pending file', async () => {
    diff.activateBatch({ fileList: [
      { path: '/a.md', original: 'a', modified: 'A' },
      { path: '/b.md', original: 'b', modified: 'B' },
    ] })
    const w = mountBar()
    await openActions(w)
    expect(w.get('[role=menu]').attributes('aria-label')).toBe('All files')
    const accept = w.findAll('[role=menuitem]')[0]
    expect(accept.text()).toBe('Accept remaining changes in all files')
    await accept.trigger('click')
    expect(diff.canFinish).toBe(true)
    expect(diff.active).toBe(true)
  })

  it('limits the focused-file menu to that file', async () => {
    diff.activateBatch({ fileList: [
      { path: '/a.md', original: 'a', modified: 'A' },
      { path: '/b.md', original: 'b', modified: 'B' },
    ] })
    diff.focusBatchFile('/a.md')
    const w = mountBar()
    await openActions(w)
    await w.findAll('[role=menuitem]')[0].trigger('click')
    expect(diff.files.map(file => file.review.pending)).toEqual([0, 1])
    expect(diff.canFinish).toBe(false)
  })

  it('supports menu keyboard navigation and Escape without a decision', async () => {
    const w = mountBar()
    await w.get('.review-menu-trigger').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(w.findAll('[role=menuitem]')[0].element)
    await w.get('[role=menu]').trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(w.findAll('[role=menuitem]')[1].element)
    await w.get('[role=menu]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[role=menu]').exists()).toBe(false)
    expect(diff.pendingChanges).toBe(1)
  })

  it('keeps Restore and Cancel for history', async () => {
    diff.activate({ original: 'old', modified: 'new', review: { type: 'history', hash: 'abc1234' } })
    const w = mountBar()
    expect(w.text()).toContain('abc1234')
    expect(w.find('.review-menu-trigger').exists()).toBe(false)
    await w.get('.review-finish').trigger('click')
    await w.get('.review-text').trigger('click')
    expect(w.emitted('accept-all')).toHaveLength(1)
    expect(w.emitted('reject-all')).toHaveLength(1)
  })
})
