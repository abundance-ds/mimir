import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DiffBar from './DiffBar.vue'
import { useDiffStore } from '../../../stores/diff.js'

describe('DiffBar', () => {
  let diff

  beforeEach(() => {
    setActivePinia(createPinia())
    diff = useDiffStore()
  })

  function mountBar() {
    return mount(DiffBar)
  }

  it('renders three view-mode buttons', () => {
    const w = mountBar()
    const btns = w.findAll('.seg-btn')
    const labels = btns.map(b => b.text())
    expect(labels).toContain('Original')
    expect(labels).toContain('Diff')
    expect(labels).toContain('Result')
  })

  it('Diff button is active by default', () => {
    const w = mountBar()
    const diffBtn = w.findAll('.seg-btn').find(b => b.text() === 'Diff')
    expect(diffBtn.classes()).toContain('active')
  })

  it('clicking Original changes viewMode in store', async () => {
    const w = mountBar()
    const origBtn = w.findAll('.seg-btn').find(b => b.text() === 'Original')
    await origBtn.trigger('click')
    expect(diff.viewMode).toBe('original')
  })

  it('clicking Result changes viewMode in store', async () => {
    const w = mountBar()
    const resBtn = w.findAll('.seg-btn').find(b => b.text() === 'Result')
    await resBtn.trigger('click')
    expect(diff.viewMode).toBe('result')
  })

  it('layout controls visible only in diff mode', async () => {
    const w = mountBar()

    // Default viewMode is 'diff', should show layout buttons
    expect(w.text()).toContain('Unified')
    expect(w.text()).toContain('Split')

    // Switch to original — layout buttons disappear
    diff.setViewMode('original')
    await w.vm.$nextTick()
    expect(w.text()).not.toContain('Unified')
    expect(w.text()).not.toContain('Split')
  })

  it('clicking Split changes layout in store', async () => {
    const w = mountBar()
    const splitBtn = w.findAll('.seg-btn').find(b => b.text() === 'Split')
    await splitBtn.trigger('click')
    expect(diff.layout).toBe('split')
  })

  it('chunk navigation hidden when no chunks', () => {
    const w = mountBar()
    expect(w.find('.chunk-counter').exists()).toBe(false)
  })

  it('chunk navigation visible when chunks exist', async () => {
    diff.setChunkCount(5)
    const w = mountBar()
    await w.vm.$nextTick()
    expect(w.find('.chunk-counter').exists()).toBe(true)
    expect(w.find('.chunk-counter').text()).toContain('1')
    expect(w.find('.chunk-counter').text()).toContain('5')
  })

  it('chunk navigation emits navigate-chunk on arrow click', async () => {
    diff.setChunkCount(3)
    const w = mountBar()
    await w.vm.$nextTick()

    const nextBtn = w.findAll('.chunk-nav-btn').at(1)
    await nextBtn.trigger('click')
    expect(diff.currentChunk).toBe(1)
    expect(w.emitted('navigate-chunk')).toBeTruthy()
    expect(w.emitted('navigate-chunk')[0]).toEqual([1])
  })

  it('emits accept-all on Accept All click', async () => {
    const w = mountBar()
    const acceptBtn = w.find('.diff-action-btn.accept')
    await acceptBtn.trigger('click')
    expect(w.emitted('accept-all')).toHaveLength(1)
  })

  it('emits reject-all on Reject All click', async () => {
    const w = mountBar()
    const rejectBtn = w.find('.diff-action-btn.reject')
    await rejectBtn.trigger('click')
    expect(w.emitted('reject-all')).toHaveLength(1)
  })

  it('prev chunk wraps from first to last', async () => {
    diff.setChunkCount(3)
    const w = mountBar()
    await w.vm.$nextTick()

    const prevBtn = w.findAll('.chunk-nav-btn').at(0)
    expect(prevBtn.attributes('disabled')).toBeUndefined()
    await prevBtn.trigger('click')
    expect(diff.currentChunk).toBe(2)
  })

  it('next chunk wraps from last to first', async () => {
    diff.setChunkCount(2)
    diff.nextChunk() // now at 1 (last)
    const w = mountBar()
    await w.vm.$nextTick()

    const nextBtn = w.findAll('.chunk-nav-btn').at(1)
    expect(nextBtn.attributes('disabled')).toBeUndefined()
    await nextBtn.trigger('click')
    expect(diff.currentChunk).toBe(0)
  })

  describe('history mode', () => {
    beforeEach(() => {
      diff.activate({
        original: 'old',
        modified: 'new',
        path: '/test.md',
        review: { type: 'history', label: 'Add methods', hash: 'abc1234', timestamp: '2026-05-18T00:00:00Z' },
      })
    })

    it('shows Restore and Cancel instead of Accept/Reject', () => {
      const w = mountBar()
      expect(w.text()).toContain('Restore')
      expect(w.text()).toContain('Cancel')
      expect(w.text()).not.toContain('Accept All')
      expect(w.text()).not.toContain('Reject All')
    })

    it('shows the commit hash and relative time', () => {
      const w = mountBar()
      expect(w.text()).toContain('abc1234')
    })

    it('Restore emits accept-all', async () => {
      const w = mountBar()
      const restoreBtn = w.find('.diff-action-btn.accept')
      await restoreBtn.trigger('click')
      expect(w.emitted('accept-all')).toHaveLength(1)
    })

    it('Cancel emits reject-all', async () => {
      const w = mountBar()
      const cancelBtn = w.find('.diff-action-btn.cancel')
      await cancelBtn.trigger('click')
      expect(w.emitted('reject-all')).toHaveLength(1)
    })
  })
})
