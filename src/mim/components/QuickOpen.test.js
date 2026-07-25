import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import QuickOpen from './QuickOpen.vue'

vi.mock('../../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(),
  filterIndexedFiles: vi.fn().mockResolvedValue([]),
  refreshWorkspaceIndex: vi.fn(),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

describe('QuickOpen', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    const files = useWorkspaceFilesStore()
    files.workspacePath = '/w'
    files.files = [
      { path: '/w/a.md', name: 'a.md', relativePath: 'a.md', mtime: 2 },
      { path: '/w/b.rs', name: 'b.rs', relativePath: 'src/b.rs', mtime: 1 },
    ]
  })

  function render(open = true) {
    return mount(QuickOpen, {
      props: { open },
      global: {
        plugins: [pinia],
        stubs: { Teleport: true, Transition: false },
      },
    })
  }

  it('uses the shared recent-first index', () => {
    const wrapper = render()
    expect(wrapper.findAll('[data-quick-open-row]').map((row) => row.text())).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('b.rs'),
    ])
  })

  it('moves selection and opens without replacing Activity', async () => {
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')

    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('openFile')[0]).toEqual(['/w/b.rs'])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape or backdrop press', async () => {
    const wrapper = render()
    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    await wrapper.get('[data-quick-open-backdrop]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('does not render while closed', () => {
    expect(render(false).find('[data-quick-open]').exists()).toBe(false)
  })
})
