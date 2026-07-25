import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { loadGitChanges } from '../../services/gitChanges.js'
import ChangesApp from './ChangesApp.vue'

vi.mock('../../services/gitChanges.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadGitChanges: vi.fn(),
}))

const changes = [
  { path: 'README.md', status: 'modified' },
  { path: 'src/new.js', status: 'new' },
  { path: 'docs/old.md', status: 'deleted' },
]

describe('ChangesApp', () => {
  beforeEach(() => {
    vi.mocked(loadGitChanges).mockReset()
    vi.mocked(loadGitChanges).mockResolvedValue(changes)
  })

  function render(props = {}) {
    return mount(ChangesApp, {
      props: {
        workspacePath: '/work',
        active: true,
        ...props,
      },
    })
  }

  it('renders a compact status ledger and filters by change kind', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('[data-change-row]')).toHaveLength(3)
    expect(wrapper.get('[data-change-summary]').text()).toContain('3 files')

    await wrapper.get('[data-change-filter="new"]').trigger('click')
    const rows = wrapper.findAll('[data-change-row]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('new.js')
  })

  it('opens an existing changed file as an absolute workspace path', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-change-row="README.md"]').trigger('dblclick')

    expect(wrapper.emitted('openFile')[0]).toEqual(['/work/README.md'])
  })

  it('keeps deleted files legible without attempting to open a missing path', async () => {
    const wrapper = render()
    await flushPromises()

    const deleted = wrapper.get('[data-change-row="docs/old.md"]')
    expect(deleted.attributes('disabled')).toBeDefined()
    await deleted.trigger('dblclick')
    expect(wrapper.emitted('openFile')).toBeUndefined()
  })

  it('offers workspace recovery before making a Git request', async () => {
    const wrapper = render({ workspacePath: '' })
    await flushPromises()

    expect(loadGitChanges).not.toHaveBeenCalled()
    await wrapper.get('[data-changes-choose-workspace]').trigger('click')
    expect(wrapper.emitted('chooseWorkspace')).toHaveLength(1)
  })

  it('shows Git failures inline and allows a retry', async () => {
    vi.mocked(loadGitChanges)
      .mockRejectedValueOnce(new Error('Not a git repo'))
      .mockResolvedValueOnce(changes)
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-changes-error]').text()).toContain('Not a git repo')
    await wrapper.get('[data-changes-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-changes-error]').exists()).toBe(false)
  })
})
