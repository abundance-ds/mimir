import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useGitReviewStore } from '../../stores/gitReview.js'
import GitChangesList from './GitChangesList.vue'

describe('GitChangesList', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    const store = useGitReviewStore()
    store.workspacePath = '/work'
    store.changes = [
      { path: 'src/both.js', oldPath: '', status: 'modified', staged: true, unstaged: true, conflicted: false },
      { path: 'new.md', oldPath: '', status: 'new', staged: false, unstaged: true, conflicted: false },
      { path: 'conflict.md', oldPath: '', status: 'conflicted', staged: false, unstaged: true, conflicted: true },
    ]
    store.setScope = vi.fn(async value => { store.scope = value })
    store.refreshChanges = vi.fn()
  })

  function render(props = {}) {
    return mount(GitChangesList, { props, global: { plugins: [pinia] } })
  }

  it('shows explicit Git states and scope counts', () => {
    const wrapper = render()
    expect(wrapper.get('[data-git-scope="all"]').text()).toContain('3')
    expect(wrapper.get('[data-git-scope="unstaged"]').text()).toContain('3')
    expect(wrapper.get('[data-git-scope="staged"]').text()).toContain('1')
    expect(wrapper.get('[data-git-change="src/both.js"]').text()).toContain('staged')
    expect(wrapper.get('[data-git-change="src/both.js"]').text()).toContain('unstaged')
    expect(wrapper.get('[data-git-change="conflict.md"]').text()).toContain('conflict')
  })

  it('previews on click and opens a surviving file on double click', async () => {
    const wrapper = render()
    await wrapper.get('[data-git-change="new.md"]').trigger('click')
    expect(wrapper.emitted('review').at(-1)).toEqual([{
      workspacePath: '/work', file: 'new.md', scope: 'all',
    }])
    await wrapper.get('[data-git-change="new.md"]').trigger('dblclick')
    expect(wrapper.emitted('openFile').at(-1)).toEqual([{
      path: '/work/new.md', preview: false,
    }])
  })

  it('moves through reviews without moving focus into the Editor', async () => {
    const wrapper = render()
    const list = wrapper.get('[data-git-changes-list]')
    await list.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('review').at(-1)[0].file).toBe('new.md')
    await list.trigger('keydown', { key: 'End' })
    expect(wrapper.emitted('review').at(-1)[0].file).toBe('conflict.md')
  })

  it('filters only the change ledger', () => {
    const wrapper = render({ query: 'src/' })
    expect(wrapper.findAll('[data-git-change]')).toHaveLength(1)
    expect(wrapper.get('[data-git-change]').attributes('data-git-change')).toBe('src/both.js')
  })

  it('shows a quiet state instead of a native error for a non-Git folder', () => {
    const store = useGitReviewStore()
    store.changes = []
    store.repositoryState = 'not-repository'
    store.changesError = ''
    const wrapper = render()
    expect(wrapper.get('[data-git-not-repository]').text()).toContain('No Git repository')
    expect(wrapper.text()).not.toContain('class=Repository')
    expect(wrapper.text()).not.toContain('Changes could not be loaded')
  })
})
