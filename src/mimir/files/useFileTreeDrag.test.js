import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { SPRING_OPEN_MS } from './useFileDrop.js'
import {
  DRAG_THRESHOLD_PX,
  resolveMoveTarget,
  useFileTreeDrag,
  wouldMove,
} from './useFileTreeDrag.js'

function makeRow(entry, options = {}) {
  return { entry, expanded: false, missing: false, editing: false, ...options }
}

const docs = makeRow({ path: '/w/docs', relativePath: 'docs', name: 'docs', isDirectory: true })
const nested = makeRow(
  { path: '/w/docs/deep', relativePath: 'docs/deep', name: 'deep', isDirectory: true },
)
const readme = makeRow(
  { path: '/w/docs/readme.md', relativePath: 'docs/readme.md', name: 'readme.md', isDirectory: false },
)
const topLevel = makeRow(
  { path: '/w/notes.md', relativePath: 'notes.md', name: 'notes.md', isDirectory: false },
)
const rows = [docs, nested, readme, topLevel]

// A tree container holding one row element per row, which is all the hit test
// reads (it walks up from the element under the cursor).
function buildTree() {
  const list = document.createElement('div')
  list.setAttribute('data-files-list', '')
  const elements = new Map()
  for (const row of rows) {
    const element = document.createElement('div')
    element.setAttribute('data-file-row', row.entry.path)
    const label = document.createElement('span')
    element.append(label)
    list.append(element)
    elements.set(row.entry.path, label)
  }
  document.body.append(list)
  return { list, elements }
}

describe('wouldMove', () => {
  it('sees through no-op and self-swallowing moves', () => {
    expect(wouldMove(topLevel.entry, 'docs')).toBe(true)
    expect(wouldMove(readme.entry, 'docs')).toBe(false)
    expect(wouldMove(topLevel.entry, '')).toBe(false)
    expect(wouldMove(docs.entry, 'docs')).toBe(false)
    expect(wouldMove(docs.entry, 'docs/deep')).toBe(false)
    expect(wouldMove(docs.entry, '')).toBe(false)
    expect(wouldMove(null, 'docs')).toBe(false)
  })
})

describe('resolveMoveTarget', () => {
  let tree

  beforeEach(() => {
    document.body.innerHTML = ''
    tree = buildTree()
  })

  it('accepts a folder that would receive at least one entry', () => {
    const target = resolveMoveTarget(
      tree.elements.get('/w/docs'), rows, tree.list, [topLevel.entry],
    )
    expect(target.relativePath).toBe('docs')
    expect(target.highlightPath).toBe('/w/docs')
  })

  it('offers no target when everything already lives there', () => {
    expect(resolveMoveTarget(
      tree.elements.get('/w/docs'), rows, tree.list, [readme.entry],
    )).toBeNull()
    expect(resolveMoveTarget(tree.list, rows, tree.list, [topLevel.entry])).toBeNull()
  })

  it('offers no target inside a dragged folder, even for a mixed drag', () => {
    expect(resolveMoveTarget(
      tree.elements.get('/w/docs/deep'), rows, tree.list, [docs.entry],
    )).toBeNull()
    // notes.md alone could land in docs/deep, but docs is about to move away
    // and must not swallow a co-dragged file's destination.
    expect(resolveMoveTarget(
      tree.elements.get('/w/docs/deep'), rows, tree.list, [docs.entry, topLevel.entry],
    )).toBeNull()
  })
})

describe('useFileTreeDrag', () => {
  let tree
  let scope
  let onMove
  let springOpen
  let dragEntries
  let canDrag
  let harness

  function mountDrag() {
    onMove = vi.fn(async () => {})
    springOpen = vi.fn()
    canDrag = vi.fn(() => true)
    dragEntries = vi.fn(row => [row.entry])
    scope = effectScope()
    scope.run(() => {
      harness = useFileTreeDrag({
        listRef: ref(tree.list),
        rows: () => rows,
        canDrag,
        dragEntries,
        onMove,
        springOpen,
      })
    })
    return harness
  }

  function press(path, { x = 0, y = 0 } = {}) {
    harness.onPointerDown({
      button: 0,
      target: tree.elements.get(path),
      clientX: x,
      clientY: y,
    })
  }

  function pointTo(path) {
    document.elementFromPoint = vi.fn(() => tree.elements.get(path) || tree.list)
  }

  function moveTo(path, { x = 50, y = 50 } = {}) {
    pointTo(path)
    document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: x, clientY: y }))
  }

  function release() {
    document.dispatchEvent(new Event('pointerup'))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    tree = buildTree()
  })

  it('moves the pressed row onto the folder it is dropped on', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    expect(drag.dragging.value).toBe(false)

    moveTo('/w/docs')
    expect(drag.dragging.value).toBe(true)
    expect(drag.draggedPaths.value.has('/w/notes.md')).toBe(true)
    expect(drag.dropTarget.value.relativePath).toBe('docs')

    release()
    expect(onMove).toHaveBeenCalledWith([topLevel.entry], 'docs')
    expect(drag.dragging.value).toBe(false)
    expect(drag.dropTarget.value).toBeNull()
  })

  it('stays a click below the drag threshold', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs', { x: DRAG_THRESHOLD_PX - 1, y: 0 })
    expect(drag.dragging.value).toBe(false)
    release()
    expect(onMove).not.toHaveBeenCalled()
    expect(drag.suppressClick.value).toBe(false)
  })

  it('suppresses the click that ends a drag, then lets clicks through again', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs')
    release()
    expect(drag.suppressClick.value).toBe(true)
    vi.advanceTimersByTime(0)
    expect(drag.suppressClick.value).toBe(false)
  })

  it('drops nowhere when released off a valid target', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs')
    // Back over its own top-level position: parent is unchanged, no target.
    moveTo('/w/notes.md')
    expect(drag.dropTarget.value).toBeNull()
    release()
    expect(onMove).not.toHaveBeenCalled()
  })

  it('cancels on Escape without moving anything', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drag.dragging.value).toBe(false)
    release()
    expect(onMove).not.toHaveBeenCalled()
  })

  it('springs a collapsed folder open while hovered', () => {
    mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs')
    vi.advanceTimersByTime(SPRING_OPEN_MS - 1)
    expect(springOpen).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(springOpen).toHaveBeenCalledWith('docs')
  })

  it('never starts from disallowed surfaces or when dragging is off', () => {
    const drag = mountDrag()
    canDrag.mockReturnValue(false)
    press('/w/notes.md')
    moveTo('/w/docs')
    expect(drag.dragging.value).toBe(false)

    canDrag.mockReturnValue(true)
    harness.onPointerDown({ button: 2, target: tree.elements.get('/w/notes.md') })
    moveTo('/w/docs')
    expect(drag.dragging.value).toBe(false)
  })

  it('gives up when the drag would carry nothing', () => {
    const drag = mountDrag()
    dragEntries.mockReturnValue([])
    press('/w/notes.md')
    moveTo('/w/docs')
    expect(drag.dragging.value).toBe(false)
    release()
    expect(onMove).not.toHaveBeenCalled()
  })

  it('detaches its listeners when the scope is torn down', () => {
    const drag = mountDrag()
    press('/w/notes.md')
    moveTo('/w/docs')
    scope.stop()
    expect(drag.dragging.value).toBe(false)
    moveTo('/w/docs/deep')
    release()
    expect(onMove).not.toHaveBeenCalled()
  })
})
