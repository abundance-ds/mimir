import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/workspaceFileOperations.js', () => ({
  openWorkspaceEntryNative: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
}))

import {
  openWorkspaceEntryNative,
  revealWorkspaceEntry,
} from '../../../services/workspaceFileOperations.js'
import FilePreviewPage from './FilePreviewPage.vue'
import { openPreviewInDefaultApp } from '../../../services/fileSystem.js'
vi.mock('../../../services/fileSystem.js', () => ({ openPreviewInDefaultApp: vi.fn(), readBinaryFile: vi.fn() }))

enableAutoUnmount(afterEach)

describe('FilePreviewPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows useful binary metadata and routes native file actions', async () => {
    const wrapper = mount(FilePreviewPage, {
      props: {
        file: {
          path: '/w/archive.zip',
          kind: 'external',
          meta: { size: 2048, mtime: 1_700_000_000_000 },
        },
      },
    })

    expect(wrapper.get('[data-external-file-preview]').text()).toContain('archive.zip')
    expect(wrapper.text()).toContain('ZIP file · 2.0 KB')

    await wrapper.get('[data-preview-open-native]').trigger('click')
    await flushPromises()
    expect(openWorkspaceEntryNative).toHaveBeenCalledWith('/w/archive.zip')

    await wrapper.get('[data-preview-reveal]').trigger('click')
    expect(revealWorkspaceEntry).toHaveBeenCalledWith('/w/archive.zip')
  })

  it('keeps native-open failures actionable on the file page', async () => {
    openWorkspaceEntryNative.mockRejectedValueOnce(new Error('No application is registered'))
    const wrapper = mount(FilePreviewPage, {
      props: {
        file: { path: '/w/archive.bin', kind: 'external', meta: {} },
      },
    })

    await wrapper.get('[data-preview-open-native]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('No application is registered')
  })

  it('prepares SVG content before opening the file outside the workspace', async () => {
    const prepareOpen = vi.fn(async () => {})
    const file = { path: '/outside/logo.svg', kind: 'text', content: '<svg/>', dirty: true }
    const wrapper = mount(FilePreviewPage, {
      props: { file, prepareOpen },
      global: { stubs: { ImagePreview: { emits: ['openNative'], template: '<button @click="$emit(\'openNative\')">Open</button>' } } },
    })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(prepareOpen).toHaveBeenCalledWith(file)
    expect(openPreviewInDefaultApp).toHaveBeenCalledWith('/outside/logo.svg')
    expect(prepareOpen.mock.invocationCallOrder[0]).toBeLessThan(openPreviewInDefaultApp.mock.invocationCallOrder[0])
    wrapper.unmount()
  })

  it('does not open SVG when its save fails', async () => {
    const wrapper = mount(FilePreviewPage, {
      props: { file: { path: '/outside/logo.svg', kind: 'text', content: '<svg/>' }, prepareOpen: async () => { throw new Error('Save failed') } },
      global: { stubs: { ImagePreview: true } },
    })
    wrapper.findComponent({ name: 'ImagePreview' }).vm.$emit('openNative')
    await flushPromises()
    expect(openPreviewInDefaultApp).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'ImagePreview' }).props('actionError')).toBe('Save failed')
    wrapper.unmount()
  })
  it('opens the requested path once even if a preview tab is reused during preparation', async () => {
    let finish
    const file = { path: '/work/first.png', kind: 'external' }
    const wrapper = mount(FilePreviewPage, {
      props: { file, prepareOpen: () => new Promise(resolve => { finish = resolve }) },
      global: { stubs: { ImagePreview: true } },
    })
    const image = wrapper.findComponent({ name: 'ImagePreview' })
    image.vm.$emit('openNative')
    image.vm.$emit('openNative')
    file.path = '/work/second.png'
    finish()
    await flushPromises()
    expect(openPreviewInDefaultApp).toHaveBeenCalledTimes(1)
    expect(openPreviewInDefaultApp).toHaveBeenCalledWith('/work/first.png')
  })

  it('refreshes on window focus and removes its listener on close', async () => {
    const onRefresh = vi.fn()
    const wrapper = mount(FilePreviewPage, {
      props: { file: { path: '/work/photo.png', kind: 'external' }, onRefresh },
      global: { stubs: { ImagePreview: true } },
    })
    window.dispatchEvent(new Event('focus'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    window.dispatchEvent(new Event('focus'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

})
