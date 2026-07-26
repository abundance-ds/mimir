import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  destroyDocument: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  readBinaryFile: vi.fn(),
  render: vi.fn(),
}))

vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {},
}))

vi.mock('../../../services/fileSystem.js', () => ({
  readBinaryFile: mocks.readBinaryFile,
}))

import PdfPreview from './PdfPreview.vue'

describe('PdfPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.readBinaryFile.mockResolvedValue(Uint8Array.from([1, 2, 3]))
    mocks.render.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve(),
    })
    mocks.getPage.mockResolvedValue({
      getViewport: ({ scale }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: mocks.render,
    })
    mocks.getDocument.mockReturnValue({
      destroy: mocks.destroyDocument,
      promise: Promise.resolve({
        getPage: mocks.getPage,
        numPages: 2,
      }),
    })
  })

  it('mounts the canvas before asking PDF.js to paint the first page', async () => {
    const wrapper = mount(PdfPreview, {
      props: { path: '/w/report.pdf' },
    })

    await flushPromises()

    expect(wrapper.get('canvas').attributes('aria-label')).toBe('PDF page 1 of 2')
    expect(mocks.getPage).toHaveBeenCalledWith(1)
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({
      canvas: wrapper.get('canvas').element,
    }))
  })
})
