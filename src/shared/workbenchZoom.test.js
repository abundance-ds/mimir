import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_ZOOM_LEVELS,
  DEFAULT_WORKBENCH_ZOOM,
  workbenchZoomKeyAction,
  clampWorkbenchZoom,
  nextWorkbenchZoom,
} from './workbenchZoom.js'

// Both modifier flags set so the tests hold on every platform regime of
// primaryModifierPressed (Cmd on macOS, Ctrl elsewhere).
function chord(overrides = {}) {
  return {
    key: '',
    code: '',
    metaKey: true,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe('clampWorkbenchZoom', () => {
  it('keeps valid percentages and rounds', () => {
    expect(clampWorkbenchZoom(125)).toBe(125)
    expect(clampWorkbenchZoom(89.6)).toBe(90)
  })

  it('clamps to the ladder bounds', () => {
    expect(clampWorkbenchZoom(10)).toBe(WORKBENCH_ZOOM_LEVELS[0])
    expect(clampWorkbenchZoom(9000)).toBe(WORKBENCH_ZOOM_LEVELS.at(-1))
  })

  it('falls back to the default for non-numeric input', () => {
    expect(clampWorkbenchZoom('big')).toBe(DEFAULT_WORKBENCH_ZOOM)
    expect(clampWorkbenchZoom(undefined)).toBe(DEFAULT_WORKBENCH_ZOOM)
    expect(clampWorkbenchZoom(null)).toBe(DEFAULT_WORKBENCH_ZOOM)
    expect(clampWorkbenchZoom(NaN)).toBe(DEFAULT_WORKBENCH_ZOOM)
  })
})

describe('nextWorkbenchZoom', () => {
  it('steps along the ladder', () => {
    expect(nextWorkbenchZoom(100, 'in')).toBe(110)
    expect(nextWorkbenchZoom(100, 'out')).toBe(90)
  })

  it('steps to the nearest ladder level from an off-ladder value', () => {
    expect(nextWorkbenchZoom(95, 'in')).toBe(100)
    expect(nextWorkbenchZoom(95, 'out')).toBe(90)
  })

  it('stops at the bounds', () => {
    expect(nextWorkbenchZoom(200, 'in')).toBe(200)
    expect(nextWorkbenchZoom(50, 'out')).toBe(50)
  })

  it('resets to the default', () => {
    expect(nextWorkbenchZoom(150, 'reset')).toBe(DEFAULT_WORKBENCH_ZOOM)
  })
})

describe('workbenchZoomKeyAction', () => {
  it('recognizes zoom-in chords including layout variants', () => {
    expect(workbenchZoomKeyAction(chord({ key: '=' }))).toBe('in')
    expect(workbenchZoomKeyAction(chord({ key: '+', shiftKey: true }))).toBe('in')
    expect(workbenchZoomKeyAction(chord({ key: '´', code: 'Equal' }))).toBe('in')
    expect(workbenchZoomKeyAction(chord({ key: '+', code: 'NumpadAdd' }))).toBe('in')
  })

  it('recognizes zoom-out chords', () => {
    expect(workbenchZoomKeyAction(chord({ key: '-' }))).toBe('out')
    expect(workbenchZoomKeyAction(chord({ key: '_', shiftKey: true }))).toBe('out')
    expect(workbenchZoomKeyAction(chord({ key: '-', code: 'NumpadSubtract' }))).toBe('out')
  })

  it('recognizes the reset chord', () => {
    expect(workbenchZoomKeyAction(chord({ key: '0', code: 'Digit0' }))).toBe('reset')
  })

  it('ignores chords without the primary modifier or with Alt', () => {
    expect(workbenchZoomKeyAction(chord({ key: '=', metaKey: false, ctrlKey: false }))).toBe(null)
    expect(workbenchZoomKeyAction(chord({ key: '=', altKey: true }))).toBe(null)
  })

  it('ignores unrelated keys', () => {
    expect(workbenchZoomKeyAction(chord({ key: 'p', code: 'KeyP' }))).toBe(null)
    expect(workbenchZoomKeyAction(chord({ key: '9', code: 'Digit9' }))).toBe(null)
  })
})
