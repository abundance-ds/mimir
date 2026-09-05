import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const DEFAULT_CHAT_CONFIG = Object.freeze({
  enabled: true,
  endpoint: 'wss://chat.abundanceds.com/webirc',
  account: 'waqr',
  displayName: 'Waqr',
})

export const DEFAULT_CHAT_STATUS = Object.freeze({
  state: 'needs_credentials',
  endpoint: DEFAULT_CHAT_CONFIG.endpoint,
  account: DEFAULT_CHAT_CONFIG.account,
  relayReady: false,
  diagnostic: null,
})

export function chatStatus() {
  return invoke('chat_status')
}

export function chatConfig() {
  return invoke('chat_config')
}

export function configureChat({ endpoint, account, displayName, password }) {
  return invoke('chat_configure', { endpoint, account, displayName, password })
}

export function updateChatConfig({ endpoint, account, displayName, password = null }) {
  return invoke('chat_update_config', {
    endpoint,
    account,
    displayName,
    password: password || null,
  })
}

export function reconnectChat() {
  return invoke('chat_reconnect')
}

export function disconnectChat() {
  return invoke('chat_disconnect')
}

export function setChatEnabled(enabled) {
  return invoke('chat_set_enabled', { enabled })
}

export function listChatTargets() {
  return invoke('chat_targets')
}

export function listChatMembers(target = null) {
  return invoke('chat_members', { target })
}

export function listChatMessages(target, { before = null, limit = 100 } = {}) {
  return invoke('chat_messages', { target, before, limit })
}

export function chatMessagesAround(target, messageId, radius = 30) {
  return invoke('chat_messages_around', { target, messageId, radius })
}

export function searchChat(query, { target = null, limit = 50 } = {}) {
  return invoke('chat_search', { query, target, limit })
}

export function sendChatMessage(target, text, replyTo = null) {
  return invoke('chat_send', { target, text, replyTo })
}

export function reactToChatMessage(target, messageId, reaction, add = true) {
  return invoke('chat_react', { target, messageId, reaction, add })
}

export function setChatTyping(target, state) {
  return invoke('chat_typing', { target, state })
}

export function editChatMessage(target, messageId, text) {
  return invoke('chat_edit', { target, messageId, text })
}

export function deleteChatMessage(target, messageId) {
  return invoke('chat_delete', { target, messageId })
}

export function uploadChatPath(target, path) {
  return invoke('chat_upload_path', { target, path })
}

export function uploadChatBase64(target, name, mime, dataBase64) {
  return invoke('chat_upload_base64', { target, name, mime, dataBase64 })
}

export function downloadChatAttachment(fileId) {
  return invoke('chat_download_attachment', { fileId })
}

export function openChatAttachment(fileId) {
  return invoke('chat_open_attachment', { fileId })
}

export function chatAttachmentPreview(fileId) {
  return invoke('chat_attachment_preview', { fileId })
}

export function createChatChannel(name, topic = null) {
  return invoke('chat_create_channel', { name, topic })
}

export function setChatTopic(target, topic) {
  return invoke('chat_set_topic', { target, topic })
}

export function joinChatChannel(target) {
  return invoke('chat_join', { target })
}

export function leaveChatChannel(target) {
  return invoke('chat_leave', { target })
}

export function openChatDirect(account) {
  return invoke('chat_open_direct', { account })
}

export function closeChatDirect(account) {
  return invoke('chat_close_direct', { account })
}

export function markChatRead(target, messageId = null) {
  return invoke('chat_mark_read', { target, messageId })
}

export function setChatMuted(target, muted) {
  return invoke('chat_set_muted', { target, muted })
}

export function setActiveChatTarget(target = null) {
  return invoke('chat_set_active', { target })
}

export function linkChatActivity(activityId, target, agentLabel = null) {
  return invoke('chat_link_activity', { activityId, target, agentLabel })
}

export function listenToChatEvents(callback) {
  return listen('mimir://chat-event', event => callback(event.payload))
}
