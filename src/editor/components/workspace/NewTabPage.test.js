import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useFileStore } from '../../../stores/files.js'
import NewTabPage from './NewTabPage.vue'

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  openFileDialog: vi.fn(),
}))

vi.mock('../../../services/fileSystem.js', () => ({
  readFile: fsMocks.readFile,
  openFileDialog: fsMocks.openFileDialog,
  saveFileDialog: vi.fn(),
  saveFile: vi.fn(),
}))

function render({ workspacePath = '' } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const files = useFileStore()
  if (workspacePath) files.setWorkspaceScope(workspacePath)
  files.newTab()
  const wrapper = mount(NewTabPage, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
  return { wrapper, files }
}

function buttonWithText(wrapper, text) {
  return wrapper.findAll('button').find(button => button.text().includes(text))
}

describe('NewTabPage', () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.openFileDialog.mockReset()
  })

  it('turns the landing tab into a blank editor without replacing draft identity', async () => {
    const { wrapper, files } = render()
    const landing = files.currentFile
    const draftId = landing.draftId

    await buttonWithText(wrapper, 'New File').trigger('click')

    expect(files.currentFile).toBe(landing)
    expect(files.currentFile.draftId).toBe(draftId)
    expect(files.currentFile.newTab).toBe(false)
    expect(wrapper.emitted('activated')).toHaveLength(1)
    wrapper.unmount()
  })

  it('replaces the landing page after a successful Open File dialog', async () => {
    fsMocks.openFileDialog.mockResolvedValue({
      path: '/docs/opened.md',
      content: '# Opened',
    })
    const { wrapper, files } = render()

    await buttonWithText(wrapper, 'Open File').trigger('click')
    await flushPromises()

    expect(files.currentFile).toMatchObject({
      path: '/docs/opened.md',
      content: '# Opened',
      newTab: false,
    })
    expect(files.openFiles).toHaveLength(1)
    expect(wrapper.emitted('activated')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps the landing page when Open File is cancelled', async () => {
    fsMocks.openFileDialog.mockResolvedValue(null)
    const { wrapper, files } = render()

    await buttonWithText(wrapper, 'Open File').trigger('click')
    await flushPromises()

    expect(files.currentFile.newTab).toBe(true)
    expect(wrapper.emitted('activated')).toBeFalsy()
    wrapper.unmount()
  })

  it('opens the file chooser at the current project root', async () => {
    fsMocks.openFileDialog.mockResolvedValue(null)
    const { wrapper } = render({ workspacePath: '/work/current-project' })

    await buttonWithText(wrapper, 'Open File').trigger('click')
    await flushPromises()

    expect(fsMocks.openFileDialog).toHaveBeenCalledWith('/work/current-project')
    wrapper.unmount()
  })

  it('filters recent files, wraps keyboard selection, and opens with Enter', async () => {
    fsMocks.readFile.mockResolvedValue('# Recent')
    const { wrapper, files } = render()
    files.setRecentFiles(['/docs/alpha.md', '/docs/beta.md'])
    await wrapper.vm.$nextTick()
    const input = wrapper.get('input')
    expect(document.activeElement).toBe(input.element)

    await input.setValue('bt')
    expect(wrapper.text()).toContain('beta.md')
    expect(wrapper.text()).not.toContain('alpha.md')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(fsMocks.readFile).toHaveBeenCalledWith('/docs/beta.md')
    expect(files.currentFile.path).toBe('/docs/beta.md')
    expect(wrapper.emitted('activated')).toHaveLength(1)
    wrapper.unmount()
  })

  it('removes a stale recent entry when it cannot be read', async () => {
    fsMocks.readFile.mockRejectedValue(new Error('gone'))
    const { wrapper, files } = render()
    files.setRecentFiles(['/docs/gone.md'])
    await wrapper.vm.$nextTick()

    await buttonWithText(wrapper, 'gone.md').trigger('click')
    await flushPromises()

    expect(files.recentFiles).toEqual([])
    expect(files.currentFile.newTab).toBe(true)
    expect(wrapper.emitted('activated')).toBeFalsy()
    wrapper.unmount()
  })
})
