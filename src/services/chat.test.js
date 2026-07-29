import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

import {
  chatMessagesAround,
  chatAttachmentPreview,
  configureChat,
  deleteChatMessage,
  downloadChatAttachment,
  editChatMessage,
  linkChatActivity,
  listChatMessages,
  listenToChatEvents,
  reactToChatMessage,
  sendChatMessage,
  setChatEnabled,
  uploadChatBase64,
  uploadChatPath,
} from './chat.js'

describe('chat service', () => {
  beforeEach(() => {
    invoke.mockReset()
    listen.mockReset()
  })

  it('keeps Tauri argument names explicit', async () => {
    await configureChat({
      endpoint: 'wss://chat.example/webirc',
      account: 'anna',
      displayName: 'Anna',
      password: 'secret',
    })
    await listChatMessages('#general', { before: 'm2', limit: 40 })
    await chatMessagesAround('#general', 'm1', 20)
    await sendChatMessage('#general', 'hello', 'm0')
    await setChatEnabled(false)
    await reactToChatMessage('#general', 'm1', '👍', true)
    await editChatMessage('#general', 'm1', 'hello, edited')
    await deleteChatMessage('#general', 'm1')
    await uploadChatPath('#general', '/tmp/launch.pdf')
    await uploadChatBase64('#general', 'paste.png', 'image/png', 'cG5n')
    await downloadChatAttachment('file-one')
    await chatAttachmentPreview('file-one')
    await linkChatActivity('agent:one', '#general', 'codex')

    expect(invoke.mock.calls).toEqual([
      ['chat_configure', {
        endpoint: 'wss://chat.example/webirc',
        account: 'anna',
        displayName: 'Anna',
        password: 'secret',
      }],
      ['chat_messages', { target: '#general', before: 'm2', limit: 40 }],
      ['chat_messages_around', {
        target: '#general',
        messageId: 'm1',
        radius: 20,
      }],
      ['chat_send', { target: '#general', text: 'hello', replyTo: 'm0' }],
      ['chat_set_enabled', { enabled: false }],
      ['chat_react', {
        target: '#general',
        messageId: 'm1',
        reaction: '👍',
        add: true,
      }],
      ['chat_edit', {
        target: '#general',
        messageId: 'm1',
        text: 'hello, edited',
      }],
      ['chat_delete', { target: '#general', messageId: 'm1' }],
      ['chat_upload_path', { target: '#general', path: '/tmp/launch.pdf' }],
      ['chat_upload_base64', {
        target: '#general',
        name: 'paste.png',
        mime: 'image/png',
        dataBase64: 'cG5n',
      }],
      ['chat_download_attachment', { fileId: 'file-one' }],
      ['chat_attachment_preview', { fileId: 'file-one' }],
      ['chat_link_activity', {
        activityId: 'agent:one',
        target: '#general',
        agentLabel: 'codex',
      }],
    ])
  })

  it('unwraps chat event payloads', async () => {
    const callback = vi.fn()
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { type: 'targets_changed' } })
      return vi.fn()
    })
    await listenToChatEvents(callback)
    expect(callback).toHaveBeenCalledWith({ type: 'targets_changed' })
  })
})
