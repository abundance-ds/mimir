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

  it('routes New to the CLI Activity chooser without stealing Editor New File', () => {
    expect(routeWorkbenchKey({
      key: 'n',
      primary: true,
      focusOwner: 'activity',
      activityNewTargetId: 'preset:review',
    })).toEqual({
      action: 'quick-open-new-activity',
      targetId: 'preset:review',
    })
    expect(routeWorkbenchKey({
      key: 'n',
      primary: true,
      focusOwner: 'activity',
      activityNewTargetId: '',
    })).toEqual({
      action: 'quick-open-new-activity',
      targetId: '',
    })
    expect(routeWorkbenchKey({
      key: 'n',
      primary: true,
      focusOwner: 'editor',
      activityNewTargetId: 'preset:review',
    })).toBeNull()
    expect(routeWorkbenchKey({
      key: 'n',
      primary: true,
      focusOwner: 'activity',
    })).toBeNull()
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
