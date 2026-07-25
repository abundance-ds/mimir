import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  controlForModel,
  defaultControlId,
  findModel,
  modelDisplayName,
  modelMenuItems,
  normalizeModelId,
  providerConfigured as aiProviderConfigured,
  resolveConcreteModel,
  resolveDefaultModel,
} from '../../services/ai/modelControls'
import {
  chatInstances,
  emptyUsage,
  sessionStatusKind,
  sessionStatusLabel,
  plainJson,
  proposalFinal,
} from './helpers.js'
import { useProjectStore } from './projects.js'
import { usePanelUIStore } from './ui.js'
import { useSettingsStore } from '../../stores/settings.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const useSessionStore = defineStore('panelSessions', () => {
  const sessions = ref([])
  const activeSessionId = ref('')
  const registry = ref(null)
  const keyStatuses = ref([])
  const archivedMetas = ref([])
  const sessionOrder = ref({})

  // ---- Computed ----

  const selectableModels = computed(() =>
    modelMenuItems(registry.value, keyStatuses.value),
  )

  const activeSession = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value)
    || sessions.value.find((s) => !s.archived)
    || null,
  )

  const activeProject = computed(() => {
    const projStore = useProjectStore()
    return projStore.projects.find((p) => p.id === activeSession.value?.projectId) || projStore.projects[0]
  })

  const configuredKeyCount = computed(() =>
    keyStatuses.value.filter((k) => k.configured).length,
  )

  const savedSessionCount = computed(() =>
    sessions.value.filter((s) => !s.archived).length,
  )

  const pinnedSessions = computed(() =>
    sessions.value
      .filter((s) => s.pinned && !s.archived)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  )

  const statusCounts = computed(() => {
    let awaitingInput = 0
    let needsApproval = 0
    let error = 0
    for (const s of sessions.value) {
      if (s.archived) continue
      const kind = sessionStatusKind(s)
      if (kind === 'needs-approval') needsApproval++
      else if (kind === 'awaiting-review') awaitingInput++
      else if (kind === 'error') error++
    }
    return { awaitingInput, needsApproval, error }
  })

  const archivedCount = computed(() => archivedMetas.value.length)

  const visibleProjects = computed(() => {
    const panelUI = usePanelUIStore()
    const projStore = useProjectStore()
    const q = panelUI.normalizedQuery()
    if (!q) return projStore.projects
    return projStore.projects.filter((p) =>
      p.name.toLowerCase().includes(q) || sessionsForProject(p.id).length > 0,
    )
  })

  // ---- Actions ----

  function createSession(modelId = null, options = {}) {
    const projStore = useProjectStore()
    const panelUI = usePanelUIStore()
    const projectId = options.projectId || activeSession.value?.projectId || projStore.projects[0].id
    const id = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const resolved = normalizeModelId(modelId, registry.value)
      || resolveLastOrDefault()
      || registry.value?.models?.[0]?.id
      || ''
    const session = {
      id,
      projectId,
      label: options.label || `Chat ${savedSessionCount.value + 1}`,
      modelId: resolved,
      controlId: defaultControlForModelId(resolved),
      proposals: [],
      usage: emptyUsage(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      pinned: false,
      projectLocked: Boolean(options.lockProject),
      lastViewedAt: new Date().toISOString(),
      lastError: '',
      _savedMessages: options.messages || [],
      type: options.type || 'chat',
      skill: null,
      appId: options.appId || null,
      appName: options.appName || null,
      appStatus: options.appStatus || null,
      appEvents: options.appEvents || null,
      appResult: null,
      appError: null,
      appInputs: options.appInputs || null,
      appStartedAt: null,
      appCompletedAt: null,
      lastInputTokens: 0,
      linkedEntries: options.linkedEntries || [],
    }
    sessions.value.unshift(session)

    activeSessionId.value = id
    panelUI.mobileChatOpen = options.openChat !== false
    projStore.expandProject(projectId)
    // Return the reactive proxy (not the plain object) so callers that pass
    // the result to getOrCreateChat capture the proxy in closures — otherwise
    // mutations like proposals.unshift() bypass Vue's reactivity tracking.
    return sessions.value[0]
  }

  function selectSession(id) {
    activeSessionId.value = id
    const session = sessions.value.find((s) => s.id === id)
    if (session) session.lastViewedAt = new Date().toISOString()
    usePanelUIStore().mobileChatOpen = true
  }

  function archiveActiveSession() {
    const session = activeSession.value
    if (!session) return
    session.archived = true
    session.updatedAt = new Date().toISOString()
    const next = sessions.value.find((s) => !s.archived)
    if (next) {
      activeSessionId.value = next.id
    }
    // If no next session, the caller should create one
  }

  function archiveSession(sessionId) {
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) return
    session.archived = true
    session.updatedAt = new Date().toISOString()
    archivedMetas.value.unshift({
      id: session.id,
      projectId: session.projectId,
      label: session.label,
      updatedAt: session.updatedAt,
      messageCount: session._savedMessages?.length || 0,
    })
    if (activeSessionId.value === sessionId) {
      const next = sessions.value.find((s) => !s.archived && s.id !== sessionId)
      if (next) activeSessionId.value = next.id
    }
  }

  async function loadArchivedSession(projectId, sessionId) {
    const inMemory = sessions.value.find((s) => s.id === sessionId)
    if (inMemory) return inMemory
    if (!isTauri) return null
    try {
      const { loadSession } = await import('../../services/dataDir')
      const full = await loadSession(projectId, sessionId)
      const session = {
        id: full.id,
        projectId: full.projectId || projectId,
        label: full.label || 'Untitled',
        modelId: normalizeModelId(full.modelId, registry.value) || '',
        controlId: full.controlId || '',
        proposals: Array.isArray(full.proposals) ? full.proposals : [],
        usage: { ...emptyUsage(), ...(full.usage || {}) },
        createdAt: full.createdAt || new Date().toISOString(),
        updatedAt: full.updatedAt || new Date().toISOString(),
        lastViewedAt: full.lastViewedAt || new Date().toISOString(),
        archived: true,
        pinned: Boolean(full.pinned),
        projectLocked: Boolean(full.projectLocked),
        lastError: '',
        _savedMessages: Array.isArray(full.messages) ? full.messages : [],
        type: full.type || 'chat',
        skill: full.skill || null,
        appId: full.appId || null,
        appName: full.appName || null,
        appStatus: full.appStatus || null,
        appEvents: Array.isArray(full.appEvents) ? full.appEvents : null,
        appResult: full.appResult || null,
        appError: full.appError || null,
        appInputs: full.appInputs || null,
        appStartedAt: full.appStartedAt || null,
        appCompletedAt: full.appCompletedAt || null,
        lastInputTokens: 0,
        linkedEntries: Array.isArray(full.linkedEntries) ? full.linkedEntries : [],
      }
      sessions.value.push(session)
      return sessions.value[sessions.value.length - 1]
    } catch { return null }
  }

  async function restoreArchivedSession(projectId, sessionId) {
    const session = await loadArchivedSession(projectId, sessionId)
    if (!session) return null
    session.archived = false
    session.updatedAt = new Date().toISOString()
    archivedMetas.value = archivedMetas.value.filter((m) => m.id !== sessionId)
    return session
  }

  async function permanentlyDeleteArchived(projectId, sessionId) {
    archivedMetas.value = archivedMetas.value.filter((m) => m.id !== sessionId)
    if (isTauri) {
      try {
        const { deleteSession: deleteFromDisk } = await import('../../services/dataDir')
        await deleteFromDisk(projectId, sessionId)
      } catch {}
    }
  }

  function removeSession(sessionId) {
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) return null
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (activeSessionId.value === sessionId) {
      const next = sessions.value.find((s) => !s.archived)
      activeSessionId.value = next?.id || ''
    }
    return session
  }

  async function deleteSession(sessionId) {
    const session = removeSession(sessionId)
    if (!session) return
    if (isTauri) {
      try {
        const { deleteSession: deleteFromDisk } = await import('../../services/dataDir')
        await deleteFromDisk(session.projectId, sessionId)
      } catch {}
    }
  }

  function renameSession(sessionId, newLabel) {
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session || !newLabel.trim()) return
    session.label = newLabel.trim()
    session.updatedAt = new Date().toISOString()
  }

  function togglePinSession(sessionId) {
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) return
    session.pinned = !session.pinned
    session.updatedAt = new Date().toISOString()
  }

  function unarchiveSession(sessionId) {
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) return
    session.archived = false
    session.updatedAt = new Date().toISOString()
    archivedMetas.value = archivedMetas.value.filter((m) => m.id !== sessionId)
  }

  function sessionsForProject(projectId) {
    const panelUI = usePanelUIStore()
    const q = panelUI.normalizedQuery()
    let result = sessions.value
      .filter((s) => !s.archived && s.projectId === projectId)
      .filter((s) => {
        if (!q) return true
        const searchable = [s.label, modelName(s.modelId), sessionStatusLabel(s), ...(s._keywords || s.keywords || [])].join(' ').toLowerCase()
        return searchable.includes(q)
      })

    const order = sessionOrder.value[projectId]
    if (order?.length) {
      const orderMap = new Map(order.map((id, i) => [id, i]))
      result.sort((a, b) => {
        const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity
        const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity
        if (ai === Infinity && bi === Infinity) return new Date(b.createdAt) - new Date(a.createdAt)
        return ai - bi
      })
    } else {
      result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    }

    if (panelUI.statusFilter) {
      const activeId = activeSessionId.value
      result = result.filter((s) => {
        if (s.pinned) return true
        if (s.id === activeId) return true
        const kind = sessionStatusKind(s)
        if (panelUI.statusFilter === 'awaiting-input') return kind === 'awaiting-review' || kind === 'needs-approval'
        if (panelUI.statusFilter === 'needs-approval') return kind === 'needs-approval'
        return kind === panelUI.statusFilter
      })
    }
    const seen = new Set()
    return result.filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  }

  function reorderSession(projectId, sessionId, beforeSessionId) {
    const current = sessionsForProject(projectId).map((s) => s.id)
    const filtered = current.filter((id) => id !== sessionId)
    if (beforeSessionId) {
      const idx = filtered.indexOf(beforeSessionId)
      if (idx >= 0) filtered.splice(idx, 0, sessionId)
      else filtered.push(sessionId)
    } else {
      filtered.push(sessionId)
    }
    sessionOrder.value = { ...sessionOrder.value, [projectId]: filtered }
  }

  function projectSessionCount(id) {
    return sessions.value.filter((s) => !s.archived && s.projectId === id).length
  }

  function setProposalStatus(proposal, status, failReason) {
    proposal.status = status
    if (failReason !== undefined) proposal.failReason = failReason
    if (activeSession.value) activeSession.value.updatedAt = new Date().toISOString()
    syncProposalsToRust()
  }

  function upsertProposalFromCoordinator(incoming) {
    if (!incoming?.id) return null
    const sessionId = incoming.threadId || incoming.sessionId || activeSession.value?.id
    const session = sessions.value.find((s) => s.id === sessionId) || activeSession.value
    if (!session) return null
    if (!Array.isArray(session.proposals)) session.proposals = []
    const idx = session.proposals.findIndex((p) => p.id === incoming.id)
    if (idx >= 0) {
      Object.assign(session.proposals[idx], incoming)
      session.updatedAt = new Date().toISOString()
      return session.proposals[idx]
    }
    session.proposals.unshift(incoming)
    session.updatedAt = new Date().toISOString()
    return incoming
  }

  function syncProposalsToRust() {
    if (!isTauri) return
    const pending = []
    for (const s of sessions.value) {
      for (const p of s.proposals || []) {
        if (p.status === 'pending') pending.push(p)
      }
    }
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('push_proposals', { proposals: pending }).catch(() => {})
    })
  }

  function findProposalById(id) {
    for (const session of sessions.value) {
      const p = session.proposals?.find((pr) => pr.id === id)
      if (p) return p
    }
    return null
  }

  function lockActiveSessionToProject(projectId) {
    const projStore = useProjectStore()
    const project = projStore.projects.find((p) => p.id === projectId)
    if (!project) return null
    const session = activeSession.value
    if (!session || sessionMessageCount(session) > 0 || (session.projectLocked && session.projectId !== projectId)) {
      return createSession(null, { projectId, lockProject: true })
    }
    session.projectId = projectId
    session.projectLocked = true
    session.updatedAt = new Date().toISOString()
    projStore.expandProject(projectId)
    return session
  }

  function setActiveDraftProject(projectId) {
    const projStore = useProjectStore()
    const project = projStore.projects.find((p) => p.id === projectId)
    if (!project) return null
    const session = activeSession.value
    if (!session || sessionMessageCount(session) > 0 || session.projectLocked) {
      return createSession(null, { projectId, openChat: true })
    }
    session.projectId = projectId
    session.updatedAt = new Date().toISOString()
    projStore.expandProject(projectId)
    return session
  }

  function sessionMessageCount(session) {
    const chat = chatInstances.get(session?.id)
    if (chat) return chat.state.messagesRef.value.length
    return session?._savedMessages?.length || 0
  }

  function normalizeSessionModels() {
    sessions.value.forEach((s) => {
      const normalized = normalizeModelId(s.modelId, registry.value)
      if (normalized && selectableModels.value.some((m) => m.id === normalized)) {
        s.modelId = normalized
      } else {
        const resolved = resolveDefaultModel(registry.value, keyStatuses.value, 'chat')
        s.modelId = resolved?.id || registry.value?.models?.[0]?.id || s.modelId
      }
      if (!validControlForSession(s, s.controlId)) {
        s.controlId = defaultControlForModelId(s.modelId)
      }
    })
  }

  // ---- Model management ----

  function modelName(id) {
    const normalized = normalizeModelId(id, registry.value)
    const model = selectableModels.value.find((m) => m.id === normalized)
    return modelDisplayName(model) || id || 'No model'
  }

  function modelOptionLabel(model) {
    const configured = providerConfigured(model.provider)
    return `${modelDisplayName(model)} · ${model.providerLabel || model.provider}${configured ? '' : ' · key missing'}`
  }

  function providerConfigured(provider) {
    return aiProviderConfigured(keyStatuses.value, provider)
  }

  function concreteModelForSession(session) {
    return resolveConcreteModel(registry.value, keyStatuses.value, session?.modelId, 'chat')
  }

  function canUseSessionModel(session) {
    return Boolean(concreteModelForSession(session))
  }

  function modelSupportsVision(session) {
    const model = concreteModelForSession(session)
    if (!model) return true
    return model.capabilities?.vision !== false
  }

  function currentControl(session) {
    return controlForModel(concreteModelForSession(session), session?.controlId)
  }

  function controlOptions(session) {
    return currentControl(session).options
  }

  function setSessionModel(session, modelId) {
    if (!session) return
    const normalized = normalizeModelId(modelId, registry.value) || modelId
    session.modelId = normalized
    session.controlId = defaultControlForModelId(normalized)
    session.updatedAt = new Date().toISOString()
    useSettingsStore().lastChatModel = normalized
  }

  function resolveLastOrDefault() {
    const last = useSettingsStore().lastChatModel
    if (last) {
      const model = findModel(registry.value, last)
      if (model && providerConfigured(model.provider)) return model.id
    }
    return resolveDefaultModel(registry.value, keyStatuses.value, 'chat')?.id
  }

  function setSessionControl(session, controlId) {
    if (!session || !validControlForSession(session, controlId)) return
    session.controlId = controlId
    session.updatedAt = new Date().toISOString()
  }

  function defaultControlForModelId(modelId) {
    const model = resolveConcreteModel(registry.value, keyStatuses.value, modelId, 'chat')
      || registry.value?.models?.find((item) => item.id === normalizeModelId(modelId, registry.value))
    return defaultControlId(model)
  }

  function validControlForSession(session, controlId) {
    const model = concreteModelForSession(session)
      || registry.value?.models?.find((item) => item.id === normalizeModelId(session?.modelId, registry.value))
    const control = controlForModel(model, controlId)
    return Boolean(control.id && control.options.some((option) => option.id === control.id))
  }

  // ---- Session export/import ----

  async function exportSession(sessionId) {
    const { snapshotSession } = await import('./persistence.js')
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) return
    const snapshot = snapshotSession(session)
    const exportData = { _format: 'mim-session-v1', exportedAt: new Date().toISOString(), session: snapshot }
    const json = JSON.stringify(exportData, null, 2)
    const filename = `${(session.label || 'session').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
    if (isTauri) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const { invoke } = await import('@tauri-apps/api/core')
        const filePath = await save({ defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (filePath) await invoke('write_text_file', { path: filePath, content: json })
      } catch (error) { console.warn('[panel] Export failed:', error) }
    } else {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }
  }

  async function importSession(projectId) {
    const targetProject = projectId || activeProject.value?.id || 'general'
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const { invoke } = await import('@tauri-apps/api/core')
        const filePath = await open({ filters: [{ name: 'JSON', extensions: ['json'] }], multiple: false })
        if (!filePath) return null
        const { content } = await invoke('read_text_file', { path: filePath })
        return _processImportedJson(content, targetProject)
      } catch (error) { console.warn('[panel] Import failed:', error); return null }
    } else {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) { resolve(null); return }
          try { resolve(_processImportedJson(await file.text(), targetProject)) }
          catch { resolve(null) }
        }
        input.click()
      })
    }
  }

  function _processImportedJson(jsonText, targetProject) {
    let data
    try { data = JSON.parse(jsonText) } catch { return null }
    if (data._format !== 'mim-session-v1' || !data.session) return null
    const imported = data.session
    if (!imported.id || !imported.messages) return null
    const session = createSession(imported.modelId, {
      projectId: targetProject,
      label: imported.label ? `${imported.label} (imported)` : 'Imported session',
      messages: Array.isArray(imported.messages) ? imported.messages : [],
    })
    if (imported.usage) session.usage = { ...emptyUsage(), ...imported.usage }
    if (Array.isArray(imported.proposals)) session.proposals = imported.proposals
    return session
  }

  return {
    sessions,
    activeSessionId,
    registry,
    keyStatuses,
    archivedMetas,
    sessionOrder,
    archivedCount,
    selectableModels,
    activeSession,
    activeProject,
    configuredKeyCount,
    savedSessionCount,
    pinnedSessions,
    statusCounts,
    visibleProjects,
    createSession,
    selectSession,
    archiveActiveSession,
    archiveSession,
    loadArchivedSession,
    restoreArchivedSession,
    permanentlyDeleteArchived,
    removeSession,
    deleteSession,
    renameSession,
    togglePinSession,
    unarchiveSession,
    sessionsForProject,
    reorderSession,
    projectSessionCount,
    setProposalStatus,
    upsertProposalFromCoordinator,
    syncProposalsToRust,
    findProposalById,
    lockActiveSessionToProject,
    setActiveDraftProject,
    sessionMessageCount,
    normalizeSessionModels,
    modelName,
    modelOptionLabel,
    providerConfigured,
    concreteModelForSession,
    canUseSessionModel,
    modelSupportsVision,
    currentControl,
    controlOptions,
    setSessionModel,
    setSessionControl,
    defaultControlForModelId,
    validControlForSession,
    exportSession,
    importSession,
  }
})
