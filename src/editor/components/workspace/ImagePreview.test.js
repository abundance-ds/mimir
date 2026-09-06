import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import ImagePreview from './ImagePreview.vue'
import { readBinaryFile } from '../../../services/fileSystem.js'

vi.mock('../../../services/fileSystem.js', () => ({ readBinaryFile: vi.fn() }))
let wrappers
let decode
let serial
let resize
let dimensions

beforeEach(() => {
  vi.useFakeTimers()
  wrappers = []
  serial = 0
  dimensions = { width: 1200, height: 800 }
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { resize = callback }
    observe() {}
    disconnect() {}
  })
  decode = vi.fn(async () => {})
  vi.stubGlobal('Image', class {
    get naturalWidth() { return dimensions.width }
    get naturalHeight() { return dimensions.height }
    decode() { return decode() }
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++serial}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  readBinaryFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
})
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mountImage(file = {}) {
  const record = reactive({ path: '/work/photo.png', kind: 'external', content: '', ...file })
  const wrapper = mount(ImagePreview, { props: { file: record } })
  wrappers.push(wrapper)
  const viewport = wrapper.get('[role="region"]').element
  Object.defineProperties(viewport, { clientWidth: { value: 648, configurable: true }, clientHeight: { value: 448, configurable: true } })
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 648, height: 448 })
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
  return { wrapper, record, viewport }
}

describe('image preview', () => {
  it('fits the image, provides actual size, and keeps image zoom separate from app shortcuts', async () => {
    const { wrapper } = await mountImage()
    expect(wrapper.get('img').attributes('style')).toContain('width: 600px')
    expect(wrapper.get('output').text()).toBe('50%')
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    expect(wrapper.get('output').text()).toBe('100%')
    await wrapper.get('[role="region"]').trigger('keydown', { key: '+', metaKey: true })
    expect(wrapper.get('output').text()).toBe('100%')
    await wrapper.get('[role="region"]').trigger('keydown', { key: '+' })
    expect(wrapper.get('output').text()).toBe('125%')
    await wrapper.get('[title="Fit image (F)"]').trigger('click')
    expect(wrapper.get('output').text()).toBe('50%')
  })

  it('zooms around the pointer and supports bounded wheel pan', async () => {
    const { wrapper } = await mountImage()
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    await wrapper.get('[role="region"]').trigger('wheel', { ctrlKey: true, deltaY: -20, clientX: 400, clientY: 224 })
    let state = wrapper.emitted('viewChange').at(-1)[0]
    expect(state.scale).toBeCloseTo(Math.exp(0.2))
    expect(state.x).toBeCloseTo(76 * (1 - Math.exp(0.2)))
    await wrapper.get('[role="region"]').trigger('wheel', { deltaX: 100000, deltaY: 100000 })
    state = wrapper.emitted('viewChange').at(-1)[0]
    expect(state.x).toBeCloseTo(-(1200 * state.scale - 648) / 2)
    expect(state.y).toBeCloseTo(-(800 * state.scale - 448) / 2)
  })

  it('refreshes changed bytes while retaining zoom and pan and releases the old image', async () => {
    const { wrapper, record } = await mountImage()
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    await wrapper.get('[role="region"]').trigger('keydown', { key: 'ArrowRight' })
    const before = wrapper.get('img').attributes('style')
    const old = wrapper.get('img').attributes('src')
    record.previewRevision = 1
    await vi.advanceTimersByTimeAsync(150)
    await flushPromises()
    expect(readBinaryFile).toHaveBeenCalledTimes(2)
    expect(wrapper.get('img').attributes('src')).not.toBe(old)
    expect(wrapper.get('img').attributes('style')).toBe(before)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(old)
  })

  it('restores the tab view after the component is mounted again', async () => {
    const { wrapper } = await mountImage({ previewView: { fit: false, scale: 2, x: -50, y: 30 } })
    expect(wrapper.get('output').text()).toBe('200%')
    expect(wrapper.get('img').attributes('style')).toContain('calc(50% + -50px)')
  })

  it('previews SVG from its current source without reading disk', async () => {
    const { wrapper, record } = await mountImage({ path: '/work/logo.svg', kind: 'text', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    expect(readBinaryFile).not.toHaveBeenCalled()
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe('image/svg+xml')
    await wrapper.get('[aria-label="SVG view"]').findAll('button')[1].trigger('click')
    expect(wrapper.emitted('sourceMode')).toEqual([[true]])
    record.content = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
    await vi.advanceTimersByTimeAsync(150)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    await wrapper.setProps({ sourceMode: true })
    expect(wrapper.get('[role="region"]').element.style.display).toBe('none')
    expect(wrapper.find('[data-preview-open-native]').exists()).toBe(true)
  })

  it('ignores a stale decode and releases every object URL', async () => {
    let finish
    decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { wrapper, record } = await mountImage()
    record.previewRevision = 1
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.get('img').attributes('src')).toBe('blob:image-2')
    finish()
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe('blob:image-2')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
    wrapper.unmount()
    wrappers = []
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-2')
  })

  it('shows decode failures and keeps the native-open action available', async () => {
    decode.mockRejectedValueOnce(new Error('The image is damaged.'))
    const { wrapper } = await mountImage()
    expect(wrapper.get('[role="alert"]').text()).toContain('The image is damaged.')
    await wrapper.get('[data-preview-open-native]').trigger('click')
    expect(wrapper.emitted('openNative')).toHaveLength(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
  })

  it('requests a bounded native read and displays size failures', async () => {
    readBinaryFile.mockRejectedValueOnce(new Error('This image is too large to preview.'))
    const { wrapper } = await mountImage()
    expect(readBinaryFile).toHaveBeenCalledWith('/work/photo.png', { maxBytes: 64 * 1024 * 1024 })
    expect(wrapper.get('[role="alert"]').text()).toContain('too large')
  })
  it('uses cumulative WebKit gesture scale once and restores wheel input after interrupted gestures', async () => {
    const { wrapper } = await mountImage()
    const region = wrapper.get('[role="region"]')
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    await region.trigger('gesturestart')
    await region.trigger('gesturechange', { scale: 1.5 })
    await region.trigger('gesturechange', { scale: 2 })
    expect(wrapper.get('output').text()).toBe('200%')
    await region.trigger('wheel', { ctrlKey: true, deltaY: -20 })
    expect(wrapper.get('output').text()).toBe('200%')
    window.dispatchEvent(new Event('blur'))
    await region.trigger('wheel', { ctrlKey: true, deltaY: -20 })
    expect(wrapper.get('output').text()).toBe('244%')
    await region.trigger('gesturestart')
    await region.trigger('gestureend')
    await region.trigger('wheel', { ctrlKey: true, deltaY: 20 })
    expect(wrapper.get('output').text()).toBe('200%')
  })

  it('releases pointer capture when dragging is cancelled or focus is lost', async () => {
    const { wrapper, viewport } = await mountImage()
    const region = wrapper.get('[role="region"]')
    viewport.setPointerCapture = vi.fn()
    viewport.hasPointerCapture = vi.fn(() => true)
    viewport.releasePointerCapture = vi.fn()
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    await region.trigger('pointerdown', { button: 0, pointerId: 7, clientX: 300, clientY: 200 })
    await region.trigger('pointermove', { pointerId: 8, clientX: 200, clientY: 100 })
    expect(wrapper.emitted('viewChange').at(-1)[0].x).toBe(0)
    await region.trigger('pointermove', { pointerId: 7, clientX: 260, clientY: 180 })
    expect(wrapper.emitted('viewChange').at(-1)[0]).toMatchObject({ x: -40, y: -20 })
    await region.trigger('pointercancel', { pointerId: 7 })
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(7)
    await region.trigger('pointerdown', { button: 0, pointerId: 9, clientX: 300, clientY: 200 })
    await region.trigger('blur')
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(region.classes()).not.toContain('cursor-grabbing')
  })

  it('fits on resize but retains explicit zoom and clamps pan when a replacement image is smaller', async () => {
    const { wrapper, record, viewport } = await mountImage()
    Object.defineProperty(viewport, 'clientWidth', { value: 348 })
    resize()
    await flushPromises()
    expect(wrapper.get('output').text()).toBe('25%')
    await wrapper.get('[title="Actual size (0)"]').trigger('click')
    await wrapper.get('[role="region"]').trigger('wheel', { deltaX: 200, deltaY: 100 })
    dimensions = { width: 200, height: 100 }
    record.previewRevision = 1
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.get('output').text()).toBe('100%')
    const view = wrapper.emitted('viewChange').at(-1)[0]
    expect(view.fit).toBe(false)
    expect(view.x).toBeCloseTo(0)
    expect(view.y).toBeCloseTo(0)
  })

  it('enforces both zoom bounds and ignores IME input', async () => {
    const { wrapper } = await mountImage()
    const region = wrapper.get('[role="region"]')
    await region.trigger('wheel', { ctrlKey: true, deltaY: -500 })
    expect(wrapper.get('output').text()).toBe('1600%')
    await region.trigger('keydown', { key: 'f', isComposing: true })
    expect(wrapper.get('output').text()).toBe('1600%')
    await region.trigger('wheel', { ctrlKey: true, deltaY: 1000 })
    expect(wrapper.get('output').text()).toBe('5%')
    expect(wrapper.get('[aria-label="Zoom out"]').attributes('disabled')).toBeDefined()
  })

  it('does not create object URLs when a disk read finishes after close', async () => {
    let finish
    readBinaryFile.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { wrapper } = await mountImage()
    wrapper.unmount()
    wrappers = []
    finish(new Uint8Array([1]))
    await flushPromises()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('recovers from a failed refresh when the next file update is valid', async () => {
    const { wrapper, record } = await mountImage()
    decode.mockRejectedValueOnce(new Error('Image data is incomplete.'))
    record.previewRevision = 1
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.get('[role="alert"]').text()).toContain('incomplete')
    record.previewRevision = 2
    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('img').attributes('src')).toBe('blob:image-3')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-2')
  })

  it('rejects oversized decoded images and releases their URL', async () => {
    dimensions = { width: 20000, height: 20000 }
    const { wrapper } = await mountImage()
    expect(wrapper.get('[role="alert"]').text()).toContain('too large')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
  })

})
