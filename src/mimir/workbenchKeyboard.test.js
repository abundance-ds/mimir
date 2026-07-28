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

  it('does not steal close or tab switching without a focus owner', () => {
    expect(routeWorkbenchKey({ key: 'w', primary: true })).toBeNull()
    expect(routeWorkbenchKey({
      key: 'ArrowRight',
      primary: true,
      alt: true,
    })).toBeNull()
  })
})
