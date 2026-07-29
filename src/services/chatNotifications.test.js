import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  requestChatNotificationPermission,
  sendChatNotification,
  updateChatBadge,
} from './chatNotifications.js'

describe('chat notifications', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(isPermissionGranted).mockReset()
    vi.mocked(requestPermission).mockReset()
    vi.mocked(sendNotification).mockReset()
    vi.mocked(isPermissionGranted).mockResolvedValue(true)
  })

  it('alerts only for a direct message or explicit channel mention', async () => {
    const message = {
      target: 'anna',
      senderNick: 'Anna',
      body: 'Can you review this?',
      own: false,
      mentioned: false,
      attachments: [],
    }
    expect(await sendChatNotification(message, { kind: 'direct' })).toBe(true)
    expect(sendNotification).toHaveBeenLastCalledWith({
      title: 'Anna',
      body: 'Can you review this?',
    })

    vi.mocked(sendNotification).mockClear()
    expect(await sendChatNotification(
      { ...message, target: '#general' },
      { kind: 'channel' },
    )).toBe(false)
    expect(sendNotification).not.toHaveBeenCalled()

    expect(await sendChatNotification(
      { ...message, target: '#general', mentioned: true },
      { kind: 'channel' },
    )).toBe(true)
  })

  it('requests permission deliberately and keeps the dock badge in sync', async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false)
    vi.mocked(requestPermission).mockResolvedValue('granted')
    expect(await requestChatNotificationPermission()).toBe('granted')

    const windowHandle = getCurrentWindow()
    vi.mocked(getCurrentWindow).mockReturnValue(windowHandle)
    await updateChatBadge(7)
    expect(windowHandle.setBadgeCount).toHaveBeenCalledWith(7)

    await updateChatBadge(0)
    expect(windowHandle.setBadgeCount).toHaveBeenLastCalledWith(undefined)

    await updateChatBadge(-2)
    expect(windowHandle.setBadgeCount).toHaveBeenLastCalledWith(undefined)
  })
})
