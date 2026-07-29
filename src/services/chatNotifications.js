import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '../shared/platform.js'

export async function requestChatNotificationPermission() {
  if (!isTauriRuntime()) return 'unsupported'
  if (await isPermissionGranted()) return 'granted'
  return requestPermission()
}

export async function chatNotificationPermission() {
  if (!isTauriRuntime()) return 'unsupported'
  return await isPermissionGranted() ? 'granted' : 'default'
}

export async function sendChatNotification(message, target) {
  if (!isTauriRuntime() || !message || message.own) return false
  if (!await isPermissionGranted()) return false
  const direct = target?.kind === 'direct'
  if (!direct && !message.mentioned) return false
  const sender = message.senderNick || message.senderAccount || 'Teammate'
  const title = direct ? sender : `${sender} in ${message.target}`
  const body = notificationBody(message)
  sendNotification({ title, body })
  return true
}

export async function updateChatBadge(count) {
  if (!isTauriRuntime()) return
  try {
    const unread = Math.max(0, Number(count) || 0)
    await getCurrentWindow().setBadgeCount(unread > 0 ? unread : undefined)
  } catch {
    // Badges are not supported on every desktop; unread state remains in-app.
  }
}

function notificationBody(message) {
  const body = String(message.body || '').replace(/\s+/g, ' ').trim()
  if (body && !isAttachmentFallback(message, body)) return body.slice(0, 180)
  const attachment = message.attachments?.[0]
  return attachment ? `Shared ${attachment.name}` : 'New message'
}

function isAttachmentFallback(message, body) {
  return message.attachments?.length === 1 && body === `📎 ${message.attachments[0].name}`
}
