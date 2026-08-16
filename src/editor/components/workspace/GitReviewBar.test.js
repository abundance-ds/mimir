import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useGitReviewStore } from '../../../stores/gitReview.js'
import { useLaunchersStore } from '../../../stores/launchers.js'
import GitReviewBar from './GitReviewBar.vue'

describe('GitReviewBar', () => {
  let pinia
  let git

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    git = useGitReviewStore()
    git.review = {
      path: 'src/app.js', status: 'modified', scope: 'all',
      staged: false, unstaged: true, conflicted: false,
      patch: 'diff --git a/src/app.js b/src/app.js', added: 4, removed: 2,
    }
    git.changes = [{
      path: 'src/app.js', status: 'modified',
      staged: false, unstaged: true, conflicted: false,
    }]
    git.stageCurrent = vi.fn()
    git.unstageCurrent = vi.fn()
    git.reviewFile = vi.fn()
    const launchers = useLaunchersStore()
    launchers.presets = [{
      id: 'codex-review', title: 'Codex', kind: 'agent', agentId: 'codex', binary: '/bin/codex',
    }]
  })

  function render(props = {}) {
    return mount(GitReviewBar, { props, global: { plugins: [pinia] } })
  }

  it('uses Git actions instead of proposal decisions', () => {
    const wrapper = render()
    expect(wrapper.text()).toContain('Stage file')
    expect(wrapper.text()).not.toContain('Copy')
    expect(wrapper.text()).not.toContain('Accept')
    expect(wrapper.text()).not.toContain('Reject')
  })

  it('does not stage a disk snapshot while the Editor has unsaved text', () => {
    const wrapper = render({ dirty: true })
    expect(wrapper.get('[data-git-stage]').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).toContain('Unsaved text not included')
  })

  it('routes a staged file with newer edits to the exact unstaged review', async () => {
    git.review = { ...git.review, scope: 'staged', staged: true, unstaged: false }
    git.changes = [{ ...git.changes[0], staged: true, unstaged: true }]
    const wrapper = render()
    expect(wrapper.get('[data-git-review-state]').text()).toBe('New edits not staged')
    await wrapper.get('[data-git-review-new-edits]').trigger('click')
    expect(git.reviewFile).toHaveBeenCalledWith('src/app.js', { scope: 'unstaged' })
  })

  it('shows when a file is ready to commit without claiming that it is committed', () => {
    git.review = { ...git.review, scope: 'staged', staged: true, unstaged: false }
    git.changes = [{ ...git.changes[0], staged: true, unstaged: false }]
    const wrapper = render()
    expect(wrapper.get('[data-git-review-state]').text()).toBe('Ready to commit')
    expect(wrapper.find('[data-git-stage]').exists()).toBe(false)
    expect(wrapper.get('[data-git-unstage]').exists()).toBe(true)
  })

  it('lets the user choose the agent before creating an editable draft', async () => {
    const wrapper = render()
    await wrapper.get('[data-git-ask-agent]').trigger('click')
    expect(wrapper.get('[data-git-agent-menu]').exists()).toBe(true)
    await wrapper.get('[data-git-agent-preset="codex-review"]').trigger('click')
    expect(wrapper.emitted('askAgent')).toEqual([['codex-review']])
  })
})
