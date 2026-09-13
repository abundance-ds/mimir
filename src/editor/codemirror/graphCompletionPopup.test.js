import { describe, expect, it } from 'vitest'
import { graphCompletionBounds, graphCompletionMetadata } from './graphCompletionPopup.js'

const viewport = { left: 0, top: 0, right: 1280, bottom: 800 }

describe('Graph completion popup bounds', () => {
  it('uses a compact 320px width within a 336px pane', () => {
    expect(graphCompletionBounds({ viewport, pane: { left: 944, top: 40, right: 1280, bottom: 774 } })).toEqual({
      space: { left: 952, top: 48, right: 1272, bottom: 766 },
      width: 320,
      maxHeight: 248,
    })
  })
  it('shrinks below the preferred width without a minimum-width overflow', () => {
    expect(graphCompletionBounds({ viewport, pane: { left: 1050, top: 40, right: 1280, bottom: 774 } }).width).toBe(214)
  })
  it('bounds right and bottom edges to the visible viewport for CodeMirror placement', () => {
    const bounds = graphCompletionBounds({
      viewport: { left: 0, top: 0, right: 900, bottom: 700 },
      pane: { left: 700, top: 600, right: 1100, bottom: 1000 },
    })
    expect(bounds).toEqual({
      space: { left: 708, top: 608, right: 892, bottom: 692 },
      width: 184,
      maxHeight: 84,
    })
    expect(bounds.space.left + bounds.width).toBeLessThanOrEqual(900)
    expect(bounds.space.top + bounds.maxHeight).toBeLessThanOrEqual(700)
  })
  it('also clips left and top pane edges and leaves space for the border', () => {
    const bounds = graphCompletionBounds({ viewport, pane: { left: -50, top: -30, right: 280, bottom: 160 } })
    expect(bounds).toEqual({ space: { left: 8, top: 8, right: 272, bottom: 152 }, width: 264, maxHeight: 144 })
  })
  it.each([1, 1.25, 2])('keeps measured CSS coordinates at zoom/DPR %s', scale => {
    const bounds = graphCompletionBounds({
      viewport: { left: 94.5, top: 50.25, right: 644.5, bottom: 450.25, scale },
      pane: { left: 400, top: 20, right: 700, bottom: 900 },
    })
    expect(bounds).toEqual({ space: { left: 408, top: 58.25, right: 636.5, bottom: 442.25 }, width: 228.5, maxHeight: 248 })
  })
  it('returns no available width for a pane beyond the viewport', () => {
    const bounds = graphCompletionBounds({ viewport, pane: { left: 1400, top: 40, right: 1700, bottom: 774 } })
    expect(bounds.width).toBe(0)
    expect(bounds.space.left).toBe(bounds.space.right)
  })
  it('does not produce negative dimensions for a nearly hidden pane', () => {
    const bounds = graphCompletionBounds({ viewport, pane: { left: 1275, top: 795, right: 1300, bottom: 900 } })
    expect(bounds.width).toBe(0)
    expect(bounds.maxHeight).toBe(0)
  })
})

describe('Graph completion row metadata', () => {
  it('keeps type and scope in separate text nodes with no HTML interpretation', () => {
    const row = graphCompletionMetadata({ graphKind: '<person>', graphScope: 'Workspace' })
    expect(row.querySelector('.cm-graph-completion-kind').textContent).toBe('<person>')
    expect(row.querySelector('.cm-graph-completion-scope').textContent).toBe('Workspace')
    expect(row.querySelector('person')).toBeNull()
  })
})
