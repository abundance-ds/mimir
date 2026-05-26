import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'

vi.mock('../../../services/board/loader.js', () => ({
  PRIORITIES: ['low', 'normal', 'high', 'urgent'],
  PRIORITY_LABELS: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
}))

import KanbanCard from './KanbanCard.vue'

function factory(entry = {}) {
  const defaultEntry = {
    id: 'issue-abc',
    meta: {
      type: 'issue',
      title: 'Test Issue',
      status: 'plan',
      priority: 'normal',
      tags: [],
      dueDate: '',
      deliverables: [],
      updated: '2026-01-01T00:00:00Z',
    },
    body: '',
  }
  const merged = { ...defaultEntry, ...entry }
  if (entry.meta) merged.meta = { ...defaultEntry.meta, ...entry.meta }
  return shallowMount(KanbanCard, {
    props: { entry: merged },
    global: { stubs: { PriorityIcon: true } },
  })
}

describe('KanbanCard', () => {
  describe('priority dropdown', () => {
    it('priority dropdown is hidden by default', () => {
      const w = factory()
      expect(w.find('.min-w-\\[110px\\]').exists()).toBe(false)
    })

    it('clicking priority icon opens dropdown', async () => {
      const w = factory()
      const toggle = w.find('.rounded.hover\\:bg-chrome-mid')
      await toggle.trigger('click')
      const dropdown = w.find('.min-w-\\[110px\\]')
      expect(dropdown.exists()).toBe(true)
      expect(dropdown.findAll('button')).toHaveLength(4)
    })

    it('selecting a priority emits update-priority and closes dropdown', async () => {
      const w = factory()
      await w.find('.rounded.hover\\:bg-chrome-mid').trigger('click')
      const buttons = w.find('.min-w-\\[110px\\]').findAll('button')
      const highBtn = buttons.find((b) => b.text().includes('High'))
      await highBtn.trigger('click')
      expect(w.emitted('update-priority')).toEqual([[{ entryId: 'issue-abc', priority: 'high' }]])
      expect(w.find('.min-w-\\[110px\\]').exists()).toBe(false)
    })
  })

  describe('inline date editing', () => {
    it('clicking date text shows date input', async () => {
      const w = factory({ meta: { dueDate: '2026-03-15' } })
      const dateSpan = w.findAll('span').find((s) => s.text().match(/\d.*Mar.*\d|Mar/))
      expect(dateSpan).toBeTruthy()
      await dateSpan.trigger('click')
      expect(w.find('input[type="date"]').exists()).toBe(true)
    })

    it('changing date emits update-due-date', async () => {
      const w = factory({ meta: { dueDate: '2026-03-15' } })
      const dateSpan = w.findAll('span').find((s) => s.text().match(/\d.*Mar|Mar.*\d/))
      await dateSpan.trigger('click')
      const input = w.find('input[type="date"]')
      input.element.value = '2026-04-01'
      await input.trigger('change')
      expect(w.emitted('update-due-date')).toEqual([[{ entryId: 'issue-abc', dueDate: '2026-04-01' }]])
    })

    it('blurring date input hides it', async () => {
      const w = factory({ meta: { dueDate: '2026-03-15' } })
      const dateSpan = w.findAll('span').find((s) => s.text().match(/\d.*Mar|Mar.*\d/))
      await dateSpan.trigger('click')
      expect(w.find('input[type="date"]').exists()).toBe(true)
      await w.find('input[type="date"]').trigger('blur')
      expect(w.find('input[type="date"]').exists()).toBe(false)
    })
  })

  describe('rendering', () => {
    it('renders title', () => {
      const w = factory()
      expect(w.text()).toContain('Test Issue')
    })

    it('shows deliverable count when present', () => {
      const w = factory({ meta: { deliverables: [{ path: '/a.md' }, { path: '/b.md' }] } })
      expect(w.text()).toContain('2 files')
    })
  })
})
