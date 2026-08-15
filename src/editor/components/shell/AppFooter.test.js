import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppFooter from './AppFooter.vue'

function mountFooter(props = {}) {
  return mount(AppFooter, {
    props: {
      zoomLevel: 100,
      stats: { words: 12, characters: 80, spaces: 10, lines: 4, readingMinutes: 1 },
      saveStatus: { label: '', tone: 'quiet' },
      ...props,
    },
  })
}

describe('AppFooter save status', () => {
  it('does not render quiet save status', () => {
    const wrapper = mountFooter()
    expect(wrapper.find('.footer-save-status').exists()).toBe(false)
  })

  it('renders unsaved changes subtly', () => {
    const wrapper = mountFooter({
      saveStatus: { label: 'Unsaved changes', tone: 'dirty', action: 'save', title: 'Save now' },
    })
    const status = wrapper.find('.footer-save-status')
    expect(status.text()).toBe('Unsaved changes')
    expect(status.classes()).toContain('save-dirty')
    expect(status.element.tagName).toBe('BUTTON')
  })

  it('renders save failures with failed tone', () => {
    const wrapper = mountFooter({
      saveStatus: { label: 'Save failed', tone: 'failed', action: 'retry', title: 'Retry save' },
    })
    const status = wrapper.find('.footer-save-status')
    expect(status.text()).toBe('Save failed')
    expect(status.classes()).toContain('save-failed')
  })

  it('emits the save status action when clicked', async () => {
    const saveStatus = {
      label: 'Auto-save on',
      tone: 'auto',
      action: 'settings',
      title: 'Auto-save settings',
      detail: 'Saved',
      detailTone: 'confirmed',
    }
    const wrapper = mountFooter({ saveStatus })
    const detail = wrapper.find('.footer-save-detail')

    expect(detail.text()).toBe('Saved')
    expect(detail.classes()).toContain('detail-confirmed')

    await wrapper.find('.footer-save-status').trigger('click')

    expect(wrapper.emitted('save-status-click')).toEqual([[saveStatus]])
  })

  it('renders non-actionable status as text', () => {
    const wrapper = mountFooter({
      saveStatus: { label: 'Saving...', tone: 'saving', action: null, title: '' },
    })

    const status = wrapper.find('.footer-save-status')
    expect(status.element.tagName).toBe('SPAN')
  })
})

describe('AppFooter resolved comment history', () => {
  it('stays absent when the document has no resolved comments', () => {
    const wrapper = mountFooter()
    expect(wrapper.find('.footer-comment-history').exists()).toBe(false)
  })

  it('shows a quiet resolved count and emits the reveal action', async () => {
    const wrapper = mountFooter({ resolvedCommentCount: 2 })
    const history = wrapper.find('.footer-comment-history')

    expect(history.text()).toContain('Resolved')
    expect(history.text()).toContain('2')
    expect(history.attributes('aria-label')).toBe('Show 2 resolved comments')
    expect(history.attributes('aria-pressed')).toBe('false')

    await history.trigger('click')
    expect(wrapper.emitted('toggle-resolved-comments')).toHaveLength(1)
  })

  it('labels the active history control as a hide action', () => {
    const wrapper = mountFooter({ resolvedCommentCount: 1, resolvedCommentsVisible: true })
    const history = wrapper.find('.footer-comment-history')

    expect(history.classes()).toContain('is-active')
    expect(history.attributes('aria-label')).toBe('Hide 1 resolved comment')
    expect(history.attributes('aria-pressed')).toBe('true')
  })
})
