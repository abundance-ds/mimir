import { flushPromises, mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import ScratchpadHistory from './ScratchpadHistory.vue'
import GitDiffView from './GitDiffView.vue'
import { useGitReviewStore } from '../../../stores/gitReview.js'

const original = '<comment id="a" author="user" text="Question">Claim</comment> old'
const modified = original.replace(' old', ' new')

it('shows clean read-only Scratchpad history and its discussions', async () => {
  const wrapper = mount(ScratchpadHistory, { props: { before: original, content: modified, changes: true } })
  expect(wrapper.find('pre').text()).not.toContain('<comment')
  expect(wrapper.find('del').text()).toContain('old')
  await wrapper.find('button').trigger('click')
  expect(wrapper.text()).toContain('Question')
  expect(wrapper.find('textarea').exists()).toBe(false)
  wrapper.unmount()
})

it('shows clean Git deletion widgets and read-only discussions', async () => {
  const git = useGitReviewStore()
  git.active = true
  git.review = { original, modified, snapshot: 'snapshot' }
  const wrapper = mount(GitDiffView)
  await flushPromises()
  expect(wrapper.find('.cm-scroller').text()).not.toContain('<comment')
  await wrapper.find('.review-discussion-bar button').trigger('click')
  expect(wrapper.text()).toContain('Question')
  expect(wrapper.find('textarea').exists()).toBe(false)
  expect(wrapper.find('button[name=accept]').exists()).toBe(false)
  wrapper.unmount()
})
