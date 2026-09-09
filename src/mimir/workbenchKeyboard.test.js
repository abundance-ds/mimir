import { describe, expect, it } from 'vitest'
import { routeWorkbenchKey } from './workbenchKeyboard.js'

describe('Workbench focus-aware keyboard routing', () => {
  it('keeps horizontal switching in Editor and vertical switching in Activity/sidebar', () => {
    expect(routeWorkbenchKey({
      key: 'ArrowRight',
      primary: true,
      alt: true,
      focusOwner: 'editor',
    })).toEqual({ action: 'cycle-editor', direction: 1 })
    expect(routeWorkbenchKey({
      key: 'ArrowLeft',
      primary: true,
      alt: true,
      focusOwner: 'activity',
    })).toEqual({ action: 'cycle-activity', direction: -1 })
    expect(routeWorkbenchKey({
      key: 'ArrowRight',
      primary: true,
      alt: true,
      focusOwner: 'sidebar',
    })).toEqual({ action: 'cycle-activity', direction: 1 })
  })

  it('routes close to the focused Editor, Activity pane, or exact sidebar row', () => {
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'editor',
    })).toEqual({ action: 'close-editor' })
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'activity',
    })).toEqual({ action: 'close-activity', activityId: '' })
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'sidebar',
      sidebarActivityId: 'agent:review',
    })).toEqual({ action: 'close-activity', activityId: 'agent:review' })
  })

  it('routes close to the Sidebar multi-selection ahead of the focused row', () => {
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'sidebar',
      sidebarActivityId: 'agent:review',
      sidebarSelectionCount: 2,
    })).toEqual({ action: 'close-selected-activities' })
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'sidebar',
      sidebarSelectionCount: 1,
    })).toEqual({ action: 'close-selected-activities' })
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'editor',
      sidebarSelectionCount: 2,
    })).toEqual({ action: 'close-editor' })
    expect(routeWorkbenchKey({
      key: 'w',
      primary: true,
      focusOwner: 'activity',
      sidebarSelectionCount: 2,
    })).toEqual({ action: 'close-activity', activityId: '' })
  })

  it.each(['activity', 'editor', 'sidebar', 'none'])('keeps global commands identical from %s', focusOwner => {
    for (const [key, action] of [['t', 'new-tab'], ['n', 'new-document'], ['p', 'quick-open'], ['b', 'toggle-sidebar'], [',', 'settings'], ['1', 'focus-main'], ['2', 'focus-editor']]) {
      expect(routeWorkbenchKey({ key, primary: true, focusOwner })).toEqual({ action })
      expect(routeWorkbenchKey({ key, primary: true, focusOwner, alt: true })).toBeNull()
    }
  })

  it('routes close without a focus owner but leaves tab switching alone', () => {
    expect(routeWorkbenchKey({ key: 'w', primary: true })).toEqual({ action: 'close-focused' })
    expect(routeWorkbenchKey({
      key: 'ArrowRight',
      primary: true,
      alt: true,
    })).toBeNull()
  })
})
