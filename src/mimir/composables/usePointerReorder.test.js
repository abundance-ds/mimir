import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePointerReorder } from './usePointerReorder.js'

describe('usePointerReorder', () => {
  let wrapper
  let api
  let root
  let onReorder

  beforeEach(() => {
    root = document.createElement('div')
    for (const [id, top] of [['a', 0], ['b', 30], ['c', 60]]) {
      const row = document.createElement('button')
      row.setAttribute('data-row-id', id)
      row.getBoundingClientRect = () => ({
        top,
        height: 20,
        bottom: top + 20,
        left: 0,
        right: 100,
        width: 100,
      })
      root.appendChild(row)
    }
    onReorder = vi.fn()
    wrapper = mount(defineComponent({
      setup() {
        api = usePointerReorder({
          root: ref(root),
          rowSelector: '[data-row-id]',
          keyAttribute: 'data-row-id',
          keys: () => ['a', 'b', 'c'],
          onReorder,
        })
        return () => h('div')
      },
    }))
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  function startAndMove() {
    api.onPointerDown(new MouseEvent('pointerdown', {
      button: 0,
      clientX: 0,
      clientY: 5,
    }), 'a')
    document.dispatchEvent(new MouseEvent('pointermove', {
      clientX: 10,
      clientY: 65,
    }))
  }

  it('cancels an active gesture on pointercancel without reordering', () => {
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'
    startAndMove()

    expect(api.dragging.value).toBe(true)
    expect(document.body.style.cursor).toBe('grabbing')
    expect(document.body.style.userSelect).toBe('none')

    document.dispatchEvent(new Event('pointercancel'))
    document.dispatchEvent(new Event('pointerup'))

    expect(onReorder).not.toHaveBeenCalled()
    expect(api.drag.value).toBeNull()
    expect(api.dropIndicator.value).toBeNull()
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
  })

  it('cancels on Escape and removes the document gesture listeners', () => {
    startAndMove()
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(escape)
    document.dispatchEvent(new Event('pointerup'))

    expect(escape.defaultPrevented).toBe(true)
    expect(onReorder).not.toHaveBeenCalled()
    expect(api.drag.value).toBeNull()
    expect(api.suppressClick.value).toBe(false)
  })
})
