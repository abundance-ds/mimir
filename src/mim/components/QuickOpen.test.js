import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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

  function render(open = true, options = {}) {
    return mount(QuickOpen, {
      props: { open },
      ...options,
      global: {
        plugins: [pinia],
        stubs: { Teleport: true, Transition: false },
        ...(options.global || {}),
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

  it('exposes one keyboard-contained dialog with combobox and listbox semantics', async () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const wrapper = render(false, { attachTo: document.body })

    await wrapper.setProps({ open: true })
    await flushPromises()
    const input = wrapper.get('[data-quick-open-input]')
    expect(wrapper.get('[data-quick-open]').attributes('role')).toBe('dialog')
    expect(wrapper.get('[data-quick-open]').attributes('aria-modal')).toBe('true')
    expect(input.attributes('role')).toBe('combobox')
    expect(input.attributes('aria-controls')).toBe('quick-open-results')
    expect(wrapper.get('#quick-open-results').attributes('role')).toBe('listbox')
    expect(document.activeElement).toBe(input.element)

    await input.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(wrapper.get('[data-quick-open-row]').element)
    await wrapper.get('[data-quick-open-row]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(input.element)

    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(previous)
    wrapper.unmount()
    previous.remove()
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

  it('cancels a delayed query when it closes', async () => {
    vi.useFakeTimers()
    try {
      const filter = vi.mocked(
        (await import('../../services/fileIndex.js')).filterIndexedFiles,
      )
      filter.mockClear()
      const wrapper = render()
      await wrapper.get('[data-quick-open-input]').setValue('src')
      await wrapper.setProps({ open: false })
      await vi.advanceTimersByTimeAsync(100)

      expect(filter).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps keyboard selection inside the rendered 100-result bound', async () => {
    const files = useWorkspaceFilesStore()
    files.files = Array.from({ length: 101 }, (_, index) => ({
      path: `/w/${index}.md`,
      name: `${index}.md`,
      relativePath: `${index}.md`,
    }))
    const wrapper = render()
    const input = wrapper.get('[data-quick-open-input]')

    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(files.selectionIndex).toBe(99)
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('openFile')[0]).toEqual(['/w/99.md'])
  })

  it('does not render while closed', () => {
    expect(render(false).find('[data-quick-open]').exists()).toBe(false)
  })
})
