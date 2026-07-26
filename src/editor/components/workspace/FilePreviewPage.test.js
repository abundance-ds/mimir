import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/workspaceFileOperations.js', () => ({
  openWorkspaceEntryNative: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
}))

import {
  openWorkspaceEntryNative,
  revealWorkspaceEntry,
} from '../../../services/workspaceFileOperations.js'
import FilePreviewPage from './FilePreviewPage.vue'

describe('FilePreviewPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows useful binary metadata and routes native file actions', async () => {
    const wrapper = mount(FilePreviewPage, {
      props: {
        file: {
          path: '/w/artwork.png',
          kind: 'external',
          meta: { size: 2048, mtime: 1_700_000_000_000 },
        },
      },
    })

    expect(wrapper.get('[data-external-file-preview]').text()).toContain('artwork.png')
    expect(wrapper.text()).toContain('PNG file · 2.0 KB')

    await wrapper.get('[data-preview-open-native]').trigger('click')
    expect(openWorkspaceEntryNative).toHaveBeenCalledWith('/w/artwork.png')

    await wrapper.get('[data-preview-reveal]').trigger('click')
    expect(revealWorkspaceEntry).toHaveBeenCalledWith('/w/artwork.png')
  })

  it('keeps native-open failures actionable on the file page', async () => {
    openWorkspaceEntryNative.mockRejectedValueOnce(new Error('No application is registered'))
    const wrapper = mount(FilePreviewPage, {
      props: {
        file: { path: '/w/archive.bin', kind: 'external', meta: {} },
      },
    })

    await wrapper.get('[data-preview-open-native]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('No application is registered')
  })
})
