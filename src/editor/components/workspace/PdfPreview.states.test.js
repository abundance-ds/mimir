import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  destroyDocument: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  readBinaryFile: vi.fn(),
  render: vi.fn(),
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {},
}))

vi.mock('../../../services/fileSystem.js', () => ({
  readBinaryFile: mocks.readBinaryFile,
}))

import PdfPreview from './PdfPreview.vue'

function mountPreview() {
  return mount(PdfPreview, { props: { path: '/w/report.pdf' } })
}

describe('PdfPreview states and controls', () => {
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

  it('shows the loading state while the document is still being read', async () => {
    mocks.readBinaryFile.mockReturnValue(new Promise(() => {}))
    const wrapper = mountPreview()
    await flushPromises()

    expect(wrapper.text()).toContain('Rendering PDF')
    expect(wrapper.find('canvas').exists()).toBe(false)
  })

  it('surfaces load failures with the cause and an escape hatch to the native app', async () => {
    mocks.readBinaryFile.mockRejectedValue(new Error('corrupt xref table'))
    const wrapper = mountPreview()
    await flushPromises()

    expect(wrapper.text()).toContain('PDF preview unavailable')
    expect(wrapper.text()).toContain('corrupt xref table')
    expect(wrapper.find('canvas').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Rendering PDF')

    await wrapper.get('button.bg-accent').trigger('click')
    expect(wrapper.emitted('openNative')).toHaveLength(1)
  })

  it('stringifies non-Error failures', async () => {
    mocks.readBinaryFile.mockRejectedValue('permission denied')
    const wrapper = mountPreview()
    await flushPromises()

    expect(wrapper.text()).toContain('permission denied')
  })

  it('steps pages with the nav buttons and disables them at the bounds', async () => {
    const wrapper = mountPreview()
    await flushPromises()

    const prev = wrapper.get('button[aria-label="Previous page"]')
    const next = wrapper.get('button[aria-label="Next page"]')
    expect(prev.attributes('disabled')).toBeDefined()
    expect(next.attributes('disabled')).toBeUndefined()

    await next.trigger('click')
    await flushPromises()

    expect(mocks.getPage).toHaveBeenCalledWith(2)
    expect(wrapper.get('input[type="number"]').element.value).toBe('2')
    expect(next.attributes('disabled')).toBeDefined()
    expect(prev.attributes('disabled')).toBeUndefined()
  })

  it('clamps manual page entry into the valid range', async () => {
    const wrapper = mountPreview()
    await flushPromises()

    const input = wrapper.get('input[type="number"]')

    input.element.value = '99'
    await input.trigger('change')
    await flushPromises()
    expect(input.element.value).toBe('2')

    input.element.value = '0'
    await input.trigger('change')
    await flushPromises()
    expect(input.element.value).toBe('1')

    input.element.value = 'not-a-number'
    await input.trigger('change')
    await flushPromises()
    expect(input.element.value).toBe('1')
  })

  it('steps zoom, re-renders, and resets from the percent button', async () => {
    const wrapper = mountPreview()
    await flushPromises()
    const rendersAfterLoad = mocks.render.mock.calls.length

    await wrapper.get('button[aria-label="Zoom in"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('110%')
    expect(mocks.render.mock.calls.length).toBeGreaterThan(rendersAfterLoad)

    await wrapper.get('button[title="Fit page width"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('100%')
  })

  it('emits openNative from the header and destroys the document on unmount', async () => {
    const wrapper = mountPreview()
    await flushPromises()

    const header = wrapper.findAll('button').find(b => b.text().includes('Open in default app'))
    await header.trigger('click')
    expect(wrapper.emitted('openNative')).toHaveLength(1)

    wrapper.unmount()
    expect(mocks.destroyDocument).toHaveBeenCalled()
  })
})
