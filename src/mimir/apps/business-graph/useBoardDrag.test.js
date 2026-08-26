import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { DRAG_THRESHOLD_PX, resolveBoardTarget, useBoardDrag } from './useBoardDrag.js'

// A board holding two columns of cards, which is all the hit test reads: it
// walks up from the element under the pointer, then measures the cards.
const COLUMNS = [
  { id: 'backlog', cards: ['issue-1', 'issue-2'] },
  { id: 'in-progress', cards: ['issue-3'] },
]

function buildBoard() {
  const track = document.createElement('div')
  const elements = new Map()
  for (const [columnIndex, column] of COLUMNS.entries()) {
    const section = document.createElement('section')
    section.setAttribute('data-board-column', column.id)
    const body = document.createElement('div')
    body.setAttribute('data-board-column-body', '')
    for (const [cardIndex, id] of column.cards.entries()) {
      const card = document.createElement('article')
      card.setAttribute('data-board-card', id)
      const top = cardIndex * 40
      card.getBoundingClientRect = () => ({ top, bottom: top + 40, height: 40 })
      const title = document.createElement('span')
      card.append(title)
      body.append(card)
      elements.set(id, title)
    }
    section.append(body)
    track.append(section)
    elements.set(column.id, body)
    elements.set(`column-${columnIndex}`, section)
  }
  document.body.append(track)
  return { track, elements }
}

describe('resolveBoardTarget', () => {
  let board

  beforeEach(() => {
    document.body.innerHTML = ''
    board = buildBoard()
  })

  it('drops before the card the pointer sits in the top half of', () => {
    expect(resolveBoardTarget(board.elements.get('issue-2'), 45, 'issue-3'))
      .toEqual({ columnId: 'backlog', beforeId: 'issue-2' })
  })

  it('drops after the card the pointer sits in the bottom half of', () => {
    expect(resolveBoardTarget(board.elements.get('issue-2'), 70, 'issue-3'))
      .toEqual({ columnId: 'backlog', beforeId: '' })
  })

  it('never measures the dragged card, so it cannot land before itself', () => {
    expect(resolveBoardTarget(board.elements.get('issue-1'), 5, 'issue-1'))
      .toEqual({ columnId: 'backlog', beforeId: 'issue-2' })
  })

  it('offers no target off the board', () => {
    expect(resolveBoardTarget(document.body, 10, '')).toBeNull()
    expect(resolveBoardTarget(null, 10, '')).toBeNull()
  })

  it('keeps a collapsed column as an empty drop target', () => {
    const column = board.elements.get('column-1')
    column.replaceChildren()
    column.setAttribute('data-board-column-collapsed', 'true')

    expect(resolveBoardTarget(column, 10, 'issue-1'))
      .toEqual({ columnId: 'in-progress', beforeId: '' })
  })
})

describe('useBoardDrag', () => {
  let board
  let scope
  let onDrop
  let harness

  function mountDrag() {
    onDrop = vi.fn()
    scope = effectScope()
    scope.run(() => {
      harness = useBoardDrag({ boardRef: ref(board.track), onDrop })
    })
    return harness
  }

  function press(id, { x = 0, y = 0 } = {}) {
    harness.onPointerDown({
      button: 0,
      target: board.elements.get(id),
      clientX: x,
      clientY: y,
    }, id)
  }

  function moveTo(id, { x = 50, y = 50 } = {}) {
    document.elementFromPoint = vi.fn(() => board.elements.get(id) || board.track)
    document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: x, clientY: y }))
  }

  function release() {
    document.dispatchEvent(new Event('pointerup'))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    board = buildBoard()
  })

  it('drops the pressed card into the column it is released over', () => {
    const drag = mountDrag()
    press('issue-1')
    expect(drag.dragging.value).toBe(false)

    moveTo('issue-3', { y: 5 })
    expect(drag.dragging.value).toBe(true)
    expect(drag.draggedId.value).toBe('issue-1')
    expect(drag.dropTarget.value).toEqual({ columnId: 'in-progress', beforeId: 'issue-3' })

    release()
    expect(onDrop).toHaveBeenCalledWith('issue-1', { columnId: 'in-progress', beforeId: 'issue-3' })
    expect(drag.dragging.value).toBe(false)
    expect(drag.dropTarget.value).toBeNull()
  })

  it('stays a click below the drag threshold', () => {
    const drag = mountDrag()
    press('issue-1')
    moveTo('issue-3', { x: DRAG_THRESHOLD_PX - 1, y: 0 })
    expect(drag.dragging.value).toBe(false)
    release()
    expect(onDrop).not.toHaveBeenCalled()
    expect(drag.suppressClick.value).toBe(false)
  })

  it('suppresses the click that ends a drag, then lets clicks through again', () => {
    const drag = mountDrag()
    press('issue-1')
    moveTo('issue-3', { y: 5 })
    release()
    expect(drag.suppressClick.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(drag.suppressClick.value).toBe(false)
  })

  it('leaves controls inside a card to their own presses', () => {
    mountDrag()
    const control = document.createElement('button')
    board.elements.get('issue-1').append(control)
    harness.onPointerDown({ button: 0, target: control, clientX: 0, clientY: 0 }, 'issue-1')
    moveTo('issue-3', { y: 5 })
    expect(harness.dragging.value).toBe(false)
    release()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('abandons the drag on Escape', () => {
    const drag = mountDrag()
    press('issue-1')
    moveTo('issue-3', { y: 5 })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drag.dragging.value).toBe(false)
    release()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('scrolls the track while the pointer rests on its edge', () => {
    const drag = mountDrag()
    board.track.getBoundingClientRect = () => ({ left: 0, right: 400 })
    Object.defineProperty(board.track, 'clientWidth', { value: 400, configurable: true })
    Object.defineProperty(board.track, 'scrollWidth', { value: 1200, configurable: true })
    press('issue-1')
    moveTo('issue-3', { x: 390, y: 5 })
    vi.advanceTimersByTime(64)
    expect(board.track.scrollLeft).toBeGreaterThan(0)
    release()
    expect(drag.dragging.value).toBe(false)
  })
})
