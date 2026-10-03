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
  function mountBar() {
    return mount(DiffBar, { attachTo: document.body, props: {
      onAcceptAll: () => diff.decideRemainingChanges('accept'),
      onRejectAll: () => diff.decideRemainingChanges('reject'),
    } })
  }
  const button = (wrapper, label) => wrapper.findAll('button').find(button => button.text() === label)

  it('shows view switches and direct actions with short labels', () => {
    const w = mountBar()
    expect(w.get('[aria-label="Review view"]').text()).toBe('OriginalDiffResult')
    expect(w.get('[aria-label="Diff layout"]').text()).toBe('UnifiedSplit')
    expect(w.get('[role=status]').attributes('aria-label')).toBe('1 change left')
    expect(button(w, 'Accept all')).toBeDefined()
    expect(button(w, 'Reject all')).toBeDefined()
    expect(w.find('[role=combobox]').exists()).toBe(false)
    expect(w.text()).not.toContain('Finish review')
  })

  it('switches views in one click and retains the selected layout', async () => {
    const w = mountBar()
    await button(w, 'Split').trigger('click')
    expect(diff.layout).toBe('split')
    expect(button(w, 'Split').attributes('aria-pressed')).toBe('true')
    for (const label of ['Original', 'Result', 'Diff']) {
      await button(w, label).trigger('click')
      expect(diff.viewMode).toBe(label.toLowerCase())
      expect(button(w, label).attributes('aria-pressed')).toBe('true')
    }
    expect(button(w, 'Split').attributes('aria-pressed')).toBe('true')
    await button(w, 'Unified').trigger('click')
    expect(diff.layout).toBe('unified')
  })

  it.each(['accept', 'reject'])('sends %s all directly to the review owner', async action => {
    const w = mountBar()
    await button(w, action === 'accept' ? 'Accept all' : 'Reject all').trigger('click')
    expect(w.emitted(`${action}-all`)).toHaveLength(1)
    expect(diff.currentReview.result).toBe(action === 'accept' ? 'new' : 'old')
    expect(diff.canFinish).toBe(true)
    expect(w.text()).not.toContain('Finish review')
  })

  it('shows Undo and Redo directly while decisions remain', async () => {
    const middle = Array.from({ length: 12 }, (_, i) => `same ${i}`).join('\n')
    diff.activate({ original: `old\n${middle}\nold`, modified: `new\n${middle}\nnew` })
    diff.recordReviewChange(diff.currentReview, `new\n${middle}\nold`, diff.currentReview.result, 'accept')
    const w = mountBar()
    await w.get('[aria-label="Undo review decision"]').trigger('click')
    expect(diff.pendingChanges).toBe(2)
    await w.get('[aria-label="Redo review decision"]').trigger('click')
    expect(diff.pendingChanges).toBe(1)
  })

  it('navigates pending changes and returns from Result to the diff', async () => {
    diff.setViewMode('result')
    const w = mountBar()
    await w.get('[aria-label="Next change"]').trigger('click')
    expect(diff.viewMode).toBe('diff')
    expect(w.emitted('navigate-chunk')).toEqual([[0]])
  })

  it('applies the direct bulk action to every pending file in the overview', async () => {
    diff.activateBatch({ fileList: [
      { path: '/a.md', original: 'a', modified: 'A' },
      { path: '/b.md', original: 'b', modified: 'B' },
    ] })
    const w = mountBar()
    await w.get('[aria-label="Previous pending file"]').trigger('click')
    expect(w.emitted('navigate-file')).toEqual([['/b.md']])
    await w.get('[aria-label="Accept remaining changes in all files"]').trigger('click')
    expect(diff.canFinish).toBe(true)
  })

  it('limits a focused-file action to that file', async () => {
    diff.activateBatch({ fileList: [
      { path: '/a.md', original: 'a', modified: 'A' },
      { path: '/b.md', original: 'b', modified: 'B' },
    ] })
    diff.focusBatchFile('/a.md')
    const w = mountBar()
    await w.get('[aria-label="Accept remaining changes in this file"]').trigger('click')
    expect(diff.files.map(file => file.review.pending)).toEqual([0, 1])
    expect(diff.canFinish).toBe(false)
  })

  it('offers Retry only after a completion error', async () => {
    diff.decideRemainingChanges('accept')
    diff.setReviewError('Could not apply this file.')
    const w = mountBar()
    expect(w.get('[role=alert]').text()).toBe('Could not apply this file.')
    await button(w, 'Retry').trigger('click')
    expect(w.emitted('finish')).toHaveLength(1)
  })

  it('keeps Restore and Cancel for history', async () => {
    diff.activate({ original: 'old', modified: 'new', review: { type: 'history', hash: 'abc1234' } })
    const w = mountBar()
    expect(w.text()).toContain('abc1234')
    expect(w.find('.review-actions').exists()).toBe(false)
    await button(w, 'Restore').trigger('click')
    await button(w, 'Cancel').trigger('click')
    expect(w.emitted('accept-all')).toHaveLength(1)
    expect(w.emitted('reject-all')).toHaveLength(1)
  })
})
