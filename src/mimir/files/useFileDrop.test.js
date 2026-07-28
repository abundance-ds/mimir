import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { platformKind } from '../../shared/platform.js'
import {
  EDGE_SCROLL_INTERVAL_MS,
  EDGE_SCROLL_STEP_PX,
  EDGE_SCROLL_ZONE_PX,
  SPRING_OPEN_MS,
  dropPoint,
  edgeScrollDirection,
  measureDropScale,
  resolveDropTarget,
  useFileDrop,
} from './useFileDrop.js'

vi.mock('../../shared/platform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  platformKind: vi.fn(() => 'macos'),
}))

function onPlatform(kind) {
  vi.mocked(platformKind).mockReturnValue(kind)
}

function withWindow(size, scaleFactor = 2) {
  window.__TAURI_INTERNALS__ = {}
  vi.mocked(getCurrentWindow).mockReturnValue({
    innerSize: async () => size,
    scaleFactor: async () => scaleFactor,
  })
}

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

// happy-dom does no layout, so scroll geometry is supplied explicitly.
function makeScrollable(list, { top = 0, height = 200, scrollHeight = 1000, scrollTop = 0 } = {}) {
  list.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 300, width: 300,
  })
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: scrollHeight })
  let position = scrollTop
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => position,
    set: (value) => { position = Math.max(0, Math.min(value, scrollHeight - height)) },
  })
  return list
}

describe('edgeScrollDirection', () => {
  it('reports the edge the point is against', () => {
    const list = makeScrollable(document.createElement('div'), { top: 100, height: 200, scrollTop: 50 })
    expect(edgeScrollDirection(list, 100 + EDGE_SCROLL_ZONE_PX - 1)).toBe(-1)
    expect(edgeScrollDirection(list, 300 - EDGE_SCROLL_ZONE_PX + 1)).toBe(1)
    expect(edgeScrollDirection(list, 200)).toBe(0)
  })

  it('stays still at the ends of the scroll range and in unscrollable lists', () => {
    const atTop = makeScrollable(document.createElement('div'), { height: 200, scrollTop: 0 })
    expect(edgeScrollDirection(atTop, 1)).toBe(0)
    expect(edgeScrollDirection(atTop, 199)).toBe(1)

    const atBottom = makeScrollable(document.createElement('div'), { height: 200, scrollTop: 800 })
    expect(edgeScrollDirection(atBottom, 199)).toBe(0)
    expect(edgeScrollDirection(atBottom, 1)).toBe(-1)

    const short = makeScrollable(document.createElement('div'), { height: 200, scrollHeight: 200 })
    expect(edgeScrollDirection(short, 1)).toBe(0)
    expect(edgeScrollDirection(null, 1)).toBe(0)
  })
})

describe('dropPoint', () => {
  it('divides the reported position by the measured scale', () => {
    expect(dropPoint({ x: 400, y: 200 }, 2)).toEqual({ x: 200, y: 100 })
    expect(dropPoint({ x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 })
  })

  it('passes the position through unscaled by default or for a nonsense scale', () => {
    expect(dropPoint({ x: 640, y: 480 })).toEqual({ x: 640, y: 480 })
    expect(dropPoint({ x: 8, y: 4 }, 0)).toEqual({ x: 8, y: 4 })
    expect(dropPoint(undefined, Number.NaN)).toEqual({ x: 0, y: 0 })
  })
})

describe('measureDropScale', () => {
  // Tauri labels the drop position "physical" but passes wry's raw platform
  // coordinates through: logical on macOS/Linux, physical on Windows.
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'main' })
    onPlatform('macos')
  })

  it('does not rescale macOS points on a Retina display', async () => {
    // 2x display, no zoom: the position already arrives in CSS pixels.
    withWindow({ width: window.innerWidth * 2, height: 100 }, 2)
    expect(await measureDropScale()).toBe(1)
  })

  it('accounts for interface zoom, which is not in devicePixelRatio', async () => {
    // 2x display at 125% zoom: 1 CSS pixel is 1.25 AppKit points.
    withWindow({ width: window.innerWidth * 2.5, height: 100 }, 2)
    expect(await measureDropScale()).toBe(1.25)
    onPlatform('linux')
    expect(await measureDropScale()).toBe(1.25)
  })

  it('keeps the full device scale on Windows, where the coordinates are physical', async () => {
    onPlatform('windows')
    withWindow({ width: window.innerWidth * 2.5, height: 100 }, 2)
    expect(await measureDropScale()).toBe(2.5)
  })

  it('falls back per platform off Tauri or when the window is unreadable', async () => {
    expect(await measureDropScale()).toBe(1)
    onPlatform('windows')
    expect(await measureDropScale()).toBe(window.devicePixelRatio || 1)

    onPlatform('macos')
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(getCurrentWindow).mockReturnValue({
      innerSize: async () => { throw new Error('no window') },
    })
    expect(await measureDropScale()).toBe(1)
  })
})

describe('resolveDropTarget', () => {
  let tree

  beforeEach(() => {
    document.body.innerHTML = ''
    tree = buildTree()
  })

  it('targets a hovered folder, including a nested one', () => {
    expect(resolveDropTarget(tree.elements.get('/w/docs'), rows)).toEqual({
      relativePath: 'docs',
      highlightPath: '/w/docs',
      collapsedDirectory: 'docs',
    })
    expect(resolveDropTarget(tree.elements.get('/w/docs/deep'), rows)).toEqual({
      relativePath: 'docs/deep',
      highlightPath: '/w/docs/deep',
      collapsedDirectory: 'docs/deep',
    })
  })

  it('reports an expanded folder as nothing to spring open', () => {
    const expanded = [{ ...docs, expanded: true }]
    expect(resolveDropTarget(tree.elements.get('/w/docs'), expanded).collapsedDirectory).toBe('')
  })

  it('targets the containing folder when a file is hovered', () => {
    expect(resolveDropTarget(tree.elements.get('/w/docs/readme.md'), rows)).toEqual({
      relativePath: 'docs',
      highlightPath: '/w/docs',
    })
    // Parent is the workspace root, so there is no row to highlight.
    expect(resolveDropTarget(tree.elements.get('/w/notes.md'), rows)).toEqual({
      relativePath: '',
      highlightPath: '',
    })
  })

  it('targets the workspace root over empty tree space', () => {
    expect(resolveDropTarget(tree.list, rows)).toEqual({ relativePath: '', highlightPath: '' })
  })

  it('declines points outside the tree, other trees, and unusable rows', () => {
    const outside = document.createElement('div')
    document.body.append(outside)
    expect(resolveDropTarget(outside, rows)).toBeNull()
    expect(resolveDropTarget(null, rows)).toBeNull()

    const other = document.createElement('div')
    other.setAttribute('data-files-list', '')
    document.body.append(other)
    expect(resolveDropTarget(tree.elements.get('/w/docs'), rows, other)).toBeNull()

    const gone = [{ ...docs, missing: true }]
    expect(resolveDropTarget(tree.elements.get('/w/docs'), gone)).toBeNull()
    expect(resolveDropTarget(tree.elements.get('/w/docs'), [])).toBeNull()
  })
})

describe('useFileDrop', () => {
  let tree
  let scope
  let importPaths
  let springOpen
  let harness

  function mountDrop({ accepts = true } = {}) {
    importPaths = vi.fn(async () => {})
    springOpen = vi.fn()
    scope = effectScope()
    scope.run(() => {
      harness = useFileDrop({
        listRef: ref(tree.list),
        rows: () => rows,
        acceptsDrop: () => accepts,
        importPaths,
        springOpen,
      })
    })
    return harness
  }

  function hoverOver(path) {
    // Stand in for the native hit test: the composable only needs the element
    // under the reported window position.
    document.elementFromPoint = vi.fn(() => tree.elements.get(path) || tree.list)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    tree = buildTree()
  })

  it('tracks the hovered folder and imports into it on drop', async () => {
    const drop = mountDrop()
    hoverOver('/w/docs/deep')
    await drop.handleDragDrop({ type: 'enter', position: { x: 0, y: 0 }, paths: ['/Desktop/a.md'] })
    expect(drop.dropTarget.value.relativePath).toBe('docs/deep')

    await drop.handleDragDrop({
      type: 'drop',
      position: { x: 0, y: 0 },
      paths: ['/Desktop/a.md', '/Desktop/photos'],
    })
    expect(importPaths).toHaveBeenCalledWith('docs/deep', ['/Desktop/a.md', '/Desktop/photos'])
    expect(drop.dropTarget.value).toBeNull()
  })

  it('springs a collapsed folder open after hovering it', async () => {
    const drop = mountDrop()
    hoverOver('/w/docs')
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    vi.advanceTimersByTime(SPRING_OPEN_MS - 1)
    expect(springOpen).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(springOpen).toHaveBeenCalledWith('docs')
  })

  it('cancels the spring when the pointer moves to another row', async () => {
    const drop = mountDrop()
    hoverOver('/w/docs')
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    hoverOver('/w/notes.md')
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    vi.advanceTimersByTime(SPRING_OPEN_MS * 2)
    expect(springOpen).not.toHaveBeenCalled()
  })

  it('clears the target when the drag leaves', async () => {
    const drop = mountDrop()
    hoverOver('/w/docs')
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    await drop.handleDragDrop({ type: 'leave' })
    expect(drop.dropTarget.value).toBeNull()
    vi.advanceTimersByTime(SPRING_OPEN_MS * 2)
    expect(springOpen).not.toHaveBeenCalled()
  })

  it('scrolls the tree while the pointer rests against an edge', async () => {
    const drop = mountDrop()
    makeScrollable(tree.list, { top: 0, height: 200, scrollHeight: 1000 })
    hoverOver('/w/docs')

    await drop.handleDragDrop({ type: 'over', position: { x: 10, y: 195 } })
    expect(tree.list.scrollTop).toBe(0)
    vi.advanceTimersByTime(EDGE_SCROLL_INTERVAL_MS * 3)
    expect(tree.list.scrollTop).toBe(EDGE_SCROLL_STEP_PX * 3)

    // Moving back into the middle stops it.
    await drop.handleDragDrop({ type: 'over', position: { x: 10, y: 100 } })
    const settled = tree.list.scrollTop
    vi.advanceTimersByTime(EDGE_SCROLL_INTERVAL_MS * 5)
    expect(tree.list.scrollTop).toBe(settled)
  })

  it('stops scrolling when the drag leaves', async () => {
    const drop = mountDrop()
    makeScrollable(tree.list, { top: 0, height: 200, scrollHeight: 1000 })
    hoverOver('/w/docs')
    await drop.handleDragDrop({ type: 'over', position: { x: 10, y: 195 } })
    vi.advanceTimersByTime(EDGE_SCROLL_INTERVAL_MS)
    const settled = tree.list.scrollTop

    await drop.handleDragDrop({ type: 'leave' })
    vi.advanceTimersByTime(EDGE_SCROLL_INTERVAL_MS * 5)
    expect(tree.list.scrollTop).toBe(settled)
  })

  it('refuses a hover while an import is running', async () => {
    const drop = mountDrop()
    let release
    importPaths.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    hoverOver('/w/docs')
    const first = drop.handleDragDrop({ type: 'drop', position: { x: 0, y: 0 }, paths: ['/a'] })
    expect(drop.importing.value).toBe(true)

    // No highlight, so the panel never promises a drop it would ignore.
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    expect(drop.dropTarget.value).toBeNull()

    release()
    await first
    await drop.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    expect(drop.dropTarget.value.relativePath).toBe('docs')
  })

  it('does not re-mark a target when a drag ends mid-measurement', async () => {
    const drop = mountDrop()
    hoverOver('/w/docs')
    const entering = drop.handleDragDrop({ type: 'enter', position: { x: 0, y: 0 }, paths: ['/a'] })
    await drop.handleDragDrop({ type: 'leave' })
    await entering
    expect(drop.dropTarget.value).toBeNull()
  })

  it('ignores drops with no workspace open and drops with no paths', async () => {
    const closed = mountDrop({ accepts: false })
    hoverOver('/w/docs')
    await closed.handleDragDrop({ type: 'over', position: { x: 0, y: 0 } })
    expect(closed.dropTarget.value).toBeNull()
    await closed.handleDragDrop({ type: 'drop', position: { x: 0, y: 0 }, paths: ['/Desktop/a.md'] })
    expect(importPaths).not.toHaveBeenCalled()

    const open = mountDrop()
    await open.handleDragDrop({ type: 'drop', position: { x: 0, y: 0 }, paths: [] })
    expect(importPaths).not.toHaveBeenCalled()
  })

  it('will not start a second import while one is running', async () => {
    const drop = mountDrop()
    let release
    importPaths.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    hoverOver('/w/docs')
    const first = drop.handleDragDrop({ type: 'drop', position: { x: 0, y: 0 }, paths: ['/a'] })
    await drop.handleDragDrop({ type: 'drop', position: { x: 0, y: 0 }, paths: ['/b'] })
    expect(importPaths).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(drop.importing.value).toBe(false)
  })
})
