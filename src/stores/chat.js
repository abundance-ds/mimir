import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_CHAT_CONFIG,
  DEFAULT_CHAT_STATUS,
  chatConfig,
  chatAttachmentPreview,
  deleteChatMessage,
  chatMessagesAround,
  chatStatus,
  closeChatDirect,
  configureChat,
  createChatChannel,
  downloadChatAttachment,
  joinChatChannel,
  leaveChatChannel,
  linkChatActivity,
  listChatMembers,
  listChatMessages,
  listChatTargets,
  listenToChatEvents,
  markChatRead,
  openChatDirect,
  openChatAttachment,
  editChatMessage,
  reactToChatMessage,
  reconnectChat,
  searchChat,
  sendChatMessage,
  setChatTyping,
  setActiveChatTarget,
  setChatEnabled,
  setChatMuted,
  setChatTopic,
  uploadChatBase64,
  uploadChatPath,
  updateChatConfig,
} from '../services/chat.js'
import {
  sendChatNotification,
  updateChatBadge,
} from '../services/chatNotifications.js'
import { useSettingsStore } from './settings.js'

export const useChatStore = defineStore('chat', () => {
  const settings = useSettingsStore()
  const status = ref({ ...DEFAULT_CHAT_STATUS })
  const config = ref({ ...DEFAULT_CHAT_CONFIG })
  const targets = shallowRef([])
  const members = shallowRef([])
  const membersByTarget = shallowRef({})
  const activeTarget = ref('')
  const messagesByTarget = shallowRef({})
  const drafts = reactive({})
  const scrollByTarget = reactive({})
  const loadingByTarget = reactive({})
  const olderComplete = reactive({})
  const windowedByTarget = reactive({})
  const focusMessageId = ref('')
  const attachmentPreviews = shallowRef({})
  const typingByTarget = shallowRef({})
  const latestLiveMessage = shallowRef(null)
  const viewActive = ref(false)
  const initialized = ref(false)
  const error = ref('')
  const searchState = reactive({
    open: false,
    query: '',
    scope: 'target',
    loading: false,
    error: '',
    results: [],
    returnable: false,
  })
  const newChatRequest = ref(null)
  let initializePromise = null
  let unlisten = null
  let searchGeneration = 0
  const typingTimers = new Map()

  const connected = computed(() => status.value.state === 'connected')
  const activeRecord = computed(
    () => targets.value.find(target => target.id === activeTarget.value) || null,
  )
  const activeMessages = computed(
    () => messagesByTarget.value[activeTarget.value] || [],
  )
  const unreadTotal = computed(() => targets.value.reduce(
    (sum, target) => sum + Math.max(0, Number(target.unreadCount) || 0),
    0,
  ))
  const channels = computed(() => targets.value.filter(target => target.kind === 'channel'))
  const directs = computed(() => targets.value.filter(target => target.kind === 'direct'))
  const activeTypers = computed(() => (typingByTarget.value[activeTarget.value] || []).map(nick => (
    members.value.find(member => member.nick.toLowerCase() === nick.toLowerCase())?.displayName
      || nick
  )))

  async function initialize() {
    if (initialized.value) return
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      error.value = ''
      try {
        if (!unlisten) unlisten = await listenToChatEvents(onEvent)
        const [nextStatus, nextConfig, nextTargets, nextMembers] = await Promise.all([
          chatStatus(),
          chatConfig(),
          listChatTargets(),
          listChatMembers(),
        ])
        status.value = nextStatus
        config.value = { ...DEFAULT_CHAT_CONFIG, ...nextConfig }
        targets.value = normalizedTargets(nextTargets)
        members.value = normalizedMembers(nextMembers)
        if (!config.value.enabled) {
          activeTarget.value = ''
        } else if (!targetExists(activeTarget.value)) {
          activeTarget.value = preferredTarget(targets.value)
        }
        if (config.value.enabled && activeTarget.value) {
          await setActiveChatTarget(activeTarget.value)
        }
        initialized.value = true
        void updateChatBadge(config.value.enabled ? unreadTotal.value : 0)
      } catch (cause) {
        error.value = errorMessage(cause)
        // Release the listener so a retry does not register a second one and
        // process every event twice.
        unlisten?.()
        unlisten = null
        throw cause
      } finally {
        initializePromise = null
      }
    })()
    return initializePromise
  }

  async function refreshTargets() {
    const nextTargets = normalizedTargets(await listChatTargets())
    targets.value = nextTargets
    if (!config.value.enabled) {
      activeTarget.value = ''
    } else if (!targetExists(activeTarget.value)) {
      activeTarget.value = preferredTarget(nextTargets)
    }
    void updateChatBadge(config.value.enabled ? unreadTotal.value : 0)
    return nextTargets
  }

  async function refreshMembers(target = null) {
    const nextMembers = normalizedMembers(await listChatMembers(target))
    if (target) {
      membersByTarget.value = {
        ...membersByTarget.value,
        [target]: nextMembers,
      }
    } else {
      members.value = nextMembers
    }
    return nextMembers
  }

  async function selectTarget(target, options = {}) {
    const id = String(target || '').trim()
    if (!id) return ''
    activeTarget.value = id
    focusMessageId.value = ''
    await setActiveChatTarget(id)
    const record = targets.value.find(candidate => candidate.id === id)
    const anchor = options.messageId || record?.firstUnreadId || ''
    if (anchor) {
      await loadAround(id, anchor)
      focusMessageId.value = anchor
    } else if (!messagesByTarget.value[id]?.length || options.refresh) {
      await loadLatest(id)
    }
    return anchor
  }

  async function loadLatest(target = activeTarget.value) {
    if (!target || loadingByTarget[target]) return messagesByTarget.value[target] || []
    loadingByTarget[target] = true
    error.value = ''
    try {
      const messages = await listChatMessages(target, { limit: 100 })
      replaceMessages(target, messages)
      olderComplete[target] = messages.length < 100
      delete windowedByTarget[target]
      return messagesByTarget.value[target]
    } catch (cause) {
      error.value = errorMessage(cause)
      throw cause
    } finally {
      loadingByTarget[target] = false
    }
  }

  async function loadOlder(target = activeTarget.value) {
    const current = messagesByTarget.value[target] || []
    if (!target || !current.length || loadingByTarget[target] || olderComplete[target]) {
      return current
    }
    loadingByTarget[target] = true
    try {
      const older = await listChatMessages(target, {
        before: current[0].id,
        limit: 100,
      })
      mergeMessages(target, older)
      olderComplete[target] = older.length < 100
      return older
    } finally {
      loadingByTarget[target] = false
    }
  }

  async function loadAround(target, messageId) {
    loadingByTarget[target] = true
    error.value = ''
    try {
      const context = await chatMessagesAround(target, messageId, 35)
      replaceMessages(target, context)
      olderComplete[target] = false
      // The room now shows a historical window: newer cached messages exist
      // below it, so live arrivals must not be appended after the gap.
      windowedByTarget[target] = true
      return context
    } catch (cause) {
      error.value = errorMessage(cause)
      throw cause
    } finally {
      loadingByTarget[target] = false
    }
  }

  async function send(text, replyTo = null, target = activeTarget.value) {
    if (!target) throw new Error('Open a chat before sending a message.')
    await sendChatMessage(target, text, replyTo)
  }

  async function setTyping(state, target = activeTarget.value) {
    if (!target || !connected.value) return
    await setChatTyping(target, state)
  }

  function setViewActive(active) {
    viewActive.value = Boolean(active)
  }

  async function react(message, reaction) {
    if (!message?.target || !message?.id) throw new Error('That message is unavailable.')
    const existing = message.reactions?.find(item => item.value === reaction)
    await reactToChatMessage(message.target, message.id, reaction, !existing?.own)
  }

  async function edit(message, text) {
    if (!message?.target || !message?.id) throw new Error('That message is unavailable.')
    await editChatMessage(message.target, message.id, text)
  }

  async function deleteMessage(message) {
    if (!message?.target || !message?.id) throw new Error('That message is unavailable.')
    await deleteChatMessage(message.target, message.id)
  }

  async function uploadPath(path, target = activeTarget.value) {
    if (!target) throw new Error('Open a chat before attaching a file.')
    return uploadChatPath(target, path)
  }

  async function uploadBase64(name, mime, dataBase64, target = activeTarget.value) {
    if (!target) throw new Error('Open a chat before attaching a file.')
    return uploadChatBase64(target, name, mime, dataBase64)
  }

  async function downloadAttachment(attachment) {
    if (!attachment?.id) throw new Error('That attachment is unavailable.')
    const downloaded = await downloadChatAttachment(attachment.id)
    updateAttachment(downloaded)
    return downloaded
  }

  async function openAttachment(attachment) {
    const available = attachment?.localPath
      ? attachment
      : await downloadAttachment(attachment)
    await openChatAttachment(available.id)
    return available
  }

  async function previewAttachment(attachment) {
    if (!attachment?.id) return ''
    if (attachmentPreviews.value[attachment.id]) {
      return attachmentPreviews.value[attachment.id]
    }
    const available = attachment.localPath
      ? attachment
      : await downloadAttachment(attachment)
    const preview = await chatAttachmentPreview(available.id)
    attachmentPreviews.value = {
      ...attachmentPreviews.value,
      [available.id]: preview,
    }
    return preview
  }

  async function markRead(messageId = null, target = activeTarget.value) {
    if (!target) return
    await markChatRead(target, messageId)
    await refreshTargets()
  }

  async function configure(nextConfig) {
    status.value = await configureChat(nextConfig)
    config.value = {
      enabled: true,
      endpoint: nextConfig.endpoint,
      account: nextConfig.account,
      displayName: nextConfig.displayName,
    }
    return status.value
  }

  async function reconnect() {
    status.value = await reconnectChat()
    return status.value
  }

  async function updateConfig(nextConfig) {
    status.value = await updateChatConfig(nextConfig)
    config.value = {
      enabled: config.value.enabled,
      endpoint: nextConfig.endpoint,
      account: nextConfig.account,
      displayName: nextConfig.displayName,
    }
    return status.value
  }

  async function setEnabled(enabled) {
    status.value = await setChatEnabled(Boolean(enabled))
    config.value = { ...config.value, enabled: Boolean(enabled) }
    if (!enabled) {
      activeTarget.value = ''
      viewActive.value = false
      await updateChatBadge(0)
    } else {
      await refreshTargets()
      activeTarget.value = preferredTarget(targets.value)
      if (activeTarget.value) await setActiveChatTarget(activeTarget.value)
    }
    return status.value
  }

  async function createChannel(name, topic = '') {
    const target = await createChatChannel(name, topic || null)
    await refreshTargets()
    await selectTarget(target, { refresh: true })
    return target
  }

  async function joinChannel(name) {
    const target = await joinChatChannel(name)
    await refreshTargets()
    await selectTarget(target, { refresh: true })
    return target
  }

  async function setTopic(target, topic) {
    await setChatTopic(target, topic)
  }

  async function openDirect(account) {
    const target = await openChatDirect(account)
    await refreshTargets()
    await selectTarget(target)
    return target
  }

  async function closeDirect(target) {
    await closeChatDirect(target)
    await refreshTargets()
    if (!targetExists(activeTarget.value)) {
      activeTarget.value = preferredTarget(targets.value)
      await setActiveChatTarget(activeTarget.value || null)
    }
  }

  async function leaveChannel(target) {
    await leaveChatChannel(target)
    await refreshTargets()
    if (!targetExists(activeTarget.value)) {
      activeTarget.value = preferredTarget(targets.value)
      await setActiveChatTarget(activeTarget.value || null)
    }
  }

  async function setMuted(target, muted) {
    await setChatMuted(target, muted)
    await refreshTargets()
  }

  async function runSearch() {
    const generation = ++searchGeneration
    const query = searchState.query.trim()
    const target = searchState.scope === 'target' ? activeTarget.value || null : null
    searchState.error = ''
    if (!query) {
      searchState.results = []
      searchState.loading = false
      return []
    }
    searchState.loading = true
    try {
      const results = await searchChat(query, { target, limit: 100 })
      if (generation !== searchGeneration) return searchState.results
      searchState.results = results
      return results
    } catch (cause) {
      if (generation !== searchGeneration) return searchState.results
      searchState.error = errorMessage(cause)
      searchState.results = []
      return []
    } finally {
      if (generation === searchGeneration) searchState.loading = false
    }
  }

  async function openSearchResult(message) {
    searchState.open = false
    searchState.returnable = true
    await selectTarget(message.target, { messageId: message.id })
  }

  function openSearch() {
    searchState.open = true
    searchState.error = ''
    searchState.returnable = false
  }

  function closeSearch({ keepReturn = false } = {}) {
    searchState.open = false
    if (!keepReturn) searchState.returnable = false
  }

  function returnToSearch() {
    if (!searchState.returnable) return false
    searchState.open = true
    searchState.returnable = false
    return true
  }

  function requestNewChat(mode = 'menu') {
    newChatRequest.value = { id: Date.now(), mode }
  }

  function clearNewChatRequest() {
    newChatRequest.value = null
  }

  function saveScroll(target, value) {
    if (!target) return
    scrollByTarget[target] = {
      top: Number(value?.top || 0),
      atBottom: Boolean(value?.atBottom),
    }
  }

  function clearFocusMessage() {
    focusMessageId.value = ''
  }

  async function linkActivity(activityId, target, agentLabel) {
    return linkChatActivity(activityId, target, agentLabel)
  }

  function dispose() {
    unlisten?.()
    unlisten = null
    initialized.value = false
    initializePromise = null
    for (const timer of typingTimers.values()) clearTimeout(timer)
    typingTimers.clear()
    typingByTarget.value = {}
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'status' && event.status) {
      status.value = event.status
      return
    }
    if (event.type === 'message' && event.message) {
      const room = event.message.target
      // Rooms without loaded history stay unloaded: merging live arrivals
      // into an empty cache would make the first open skip its history
      // fetch and show a partial transcript.
      const loaded = Object.prototype.hasOwnProperty.call(messagesByTarget.value, room)
      const known = (messagesByTarget.value[room] || []).some(
        message => message.id === event.message.id,
      )
      if (loaded && (known || !windowedByTarget[room])) {
        mergeMessages(room, [event.message])
      }
      // Edit/reaction/redaction materializations arrive as message events for
      // an id that is already cached; only genuinely new messages count as
      // live arrivals.
      if (!known) latestLiveMessage.value = event.message
      const target = targets.value.find(candidate => candidate.id === event.message.target)
        || {
          id: event.message.target,
          kind: event.message.target.startsWith('#') ? 'channel' : 'direct',
          muted: false,
        }
      const visible = viewActive.value
        && activeTarget.value === event.message.target
        && typeof document !== 'undefined'
        && document.hasFocus()
      if (event.notify && !target.muted && settings.chatNotifications && !visible) {
        void sendChatNotification(event.message, target)
      }
      void refreshTargets()
      return
    }
    if (event.type === 'typing' && event.target && event.senderNick) {
      updateTyping(event.target, event.senderNick, event.active)
      return
    }
    if (event.type === 'targets_changed') {
      void Promise.all([refreshTargets(), refreshMembers()])
    }
  }

  function updateTyping(target, nick, active) {
    const key = `${target.toLowerCase()}\0${nick.toLowerCase()}`
    const previous = typingTimers.get(key)
    if (previous) clearTimeout(previous)
    typingTimers.delete(key)
    const current = typingByTarget.value[target] || []
    const next = active
      ? [...new Set([...current, nick])]
      : current.filter(candidate => candidate.toLowerCase() !== nick.toLowerCase())
    typingByTarget.value = {
      ...typingByTarget.value,
      [target]: next,
    }
    if (active) {
      typingTimers.set(key, setTimeout(() => updateTyping(target, nick, false), 6500))
    }
  }

  function targetExists(target) {
    return Boolean(target && targets.value.some(candidate => candidate.id === target))
  }

  return {
    status,
    config,
    targets,
    members,
    membersByTarget,
    activeTarget,
    messagesByTarget,
    drafts,
    scrollByTarget,
    loadingByTarget,
    olderComplete,
    windowedByTarget,
    focusMessageId,
    attachmentPreviews,
    typingByTarget,
    latestLiveMessage,
    viewActive,
    initialized,
    error,
    searchState,
    newChatRequest,
    connected,
    activeRecord,
    activeMessages,
    unreadTotal,
    channels,
    directs,
    activeTypers,
    initialize,
    refreshTargets,
    refreshMembers,
    selectTarget,
    loadLatest,
    loadOlder,
    loadAround,
    send,
    setTyping,
    setViewActive,
    react,
    edit,
    deleteMessage,
    uploadPath,
    uploadBase64,
    downloadAttachment,
    openAttachment,
    previewAttachment,
    markRead,
    configure,
    reconnect,
    updateConfig,
    setEnabled,
    createChannel,
    joinChannel,
    setTopic,
    openDirect,
    closeDirect,
    leaveChannel,
    setMuted,
    runSearch,
    openSearchResult,
    openSearch,
    closeSearch,
    returnToSearch,
    requestNewChat,
    clearNewChatRequest,
    saveScroll,
    clearFocusMessage,
    linkActivity,
    dispose,
  }

  function replaceMessages(target, values) {
    messagesByTarget.value = {
      ...messagesByTarget.value,
      [target]: sortedUnique(values),
    }
  }

  function mergeMessages(target, values) {
    replaceMessages(target, [
      ...(messagesByTarget.value[target] || []),
      ...values,
    ])
  }

  function updateAttachment(attachment) {
    const next = {}
    for (const [target, messages] of Object.entries(messagesByTarget.value)) {
      next[target] = messages.map(message => ({
        ...message,
        attachments: (message.attachments || []).map(candidate => (
          candidate.id === attachment.id ? attachment : candidate
        )),
      }))
    }
    messagesByTarget.value = next
  }
})

function normalizedTargets(values) {
  return Array.isArray(values) ? values.filter(target => target?.id) : []
}

function normalizedMembers(values) {
  return Array.isArray(values) ? values.filter(member => member?.nick) : []
}

function preferredTarget(targets) {
  return targets.find(target => target.id === '#general')?.id || targets[0]?.id || ''
}

function sortedUnique(values) {
  const byId = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    if (value?.id) byId.set(value.id, value)
  }
  return [...byId.values()].sort((left, right) => (
    String(left.serverTime).localeCompare(String(right.serverTime))
      || String(left.id).localeCompare(String(right.id))
  ))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Chat is unavailable.')
}
