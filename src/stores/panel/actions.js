// Cross-store actions that coordinate between multiple panel stores.
// These replace the wrapper functions that were in usePanelStore.js.

import { usePanelUIStore } from './ui.js'
import { useProjectStore } from './projects.js'
import { useSessionStore } from './sessions.js'
import { useChatStore } from './chat.js'
import { useAppStore } from './apps.js'
import { useBoardStore } from './board.js'
import { schedulePersist } from './persistence.js'
import { logAudit } from '../../services/audit.js'
import { emit as telemetryEmit } from '../../services/telemetry.js'
import { clearSessionAllowList } from '../../services/ai/tools/gate.js'
import { chatInstances, cleanMessagesForPersist, sessionStatusKind } from './helpers.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

function flushChatToSession(session) {
  const chat = chatInstances.get(session.id)
  if (!chat) return
  const raw = chat.state.messagesRef.value.map((m) => ({ ...m, parts: (m.parts || []).map((p) => ({ ...p })) }))
  session._savedMessages = cleanMessagesForPersist(raw)
}

export function selectSession(id) {
  clearSessionAllowList()
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()
  panelUI.closeProjectHome()
  sessionStore.selectSession(id)
  panelUI.pushHistory(id)
  const session = sessionStore.sessions.find((s) => s.id === id)
  if (session && session.type !== 'app') {
    chatStore.getOrCreateChat(session)
  }
  panelUI.closeSidebarOnNarrow()
}

export function navigateHistory(direction) {
  const panelUI = usePanelUIStore()
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const projStore = useProjectStore()
  const boardStore = useBoardStore()
  const step = direction === 'back' ? () => panelUI.goBack() : () => panelUI.goForward()

  panelUI.setNavigatingHistory(true)
  try {
    let entry = step()
    while (entry && isDeadEntry(entry, sessionStore, projStore)) {
      entry = step()
    }
    if (!entry) return

    if (entry.type === 'session') {
      clearSessionAllowList()
      panelUI.closeProjectHome()
      sessionStore.selectSession(entry.id)
      const session = sessionStore.sessions.find(s => s.id === entry.id)
      if (session && session.type !== 'app') chatStore.getOrCreateChat(session)
    } else if (entry.type === 'project') {
      panelUI.projectHomeId = entry.id
      boardStore.viewMode = entry.viewMode || 'chat'
      if (entry.entryId) boardStore.selectEntry(entry.entryId)
      else boardStore.clearSelection()
    }
  } finally {
    panelUI.setNavigatingHistory(false)
  }
}

function isDeadEntry(entry, sessionStore, projStore) {
  if (entry.type === 'session') {
    return !sessionStore.sessions.find(s => s.id === entry.id && !s.archived)
  }
  if (entry.type === 'project') {
    return !projStore.projects.find(p => p.id === entry.id)
  }
  return true
}

export function archiveActiveSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const projStore = useProjectStore()
  const panelUI = usePanelUIStore()
  const session = sessionStore.activeSession
  if (!session) return
  const sessionId = session.id
  flushChatToSession(session)
  chatStore.destroyChat(sessionId)
  sessionStore.archiveSession(sessionId)
  logAudit('session.archive', {
    sessionId,
    projectId: session.projectId,
  })
  if (!sessionStore.sessions.find((s) => !s.archived)) {
    sessionStore.createSession(null, { projectId: projStore.projects[0].id })
    chatStore.getOrCreateChat(sessionStore.sessions[0])
  }
  panelUI.setUndoToast('Session archived', [{ sessionId }])
  schedulePersist()
}

export async function deleteSession(sessionId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const session = sessionStore.sessions.find((s) => s.id === sessionId)
  const projectId = session?.projectId
  chatStore.destroyChat(sessionId)
  await sessionStore.deleteSession(sessionId)
  logAudit('session.delete', {
    sessionId: sessionId,
    projectId: projectId,
  })
  if (!sessionStore.sessions.find((s) => !s.archived)) {
    sessionStore.createSession(null, { openChat: false })
    chatStore.getOrCreateChat(sessionStore.sessions[0])
  }
  schedulePersist()
}

export function renameSession(sessionId, newLabel) {
  const sessionStore = useSessionStore()
  sessionStore.renameSession(sessionId, newLabel)
  schedulePersist()
}

export function togglePinSession(sessionId) {
  const sessionStore = useSessionStore()
  sessionStore.togglePinSession(sessionId)
  schedulePersist()
}

export function unarchiveSession(sessionId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  sessionStore.unarchiveSession(sessionId)
  const session = sessionStore.sessions.find((s) => s.id === sessionId)
  if (session && session.type !== 'app') chatStore.getOrCreateChat(session)
  schedulePersist()
}

export function doneSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()
  const session = sessionStore.activeSession
  if (!session) return
  const sessionId = session.id
  flushChatToSession(session)
  chatStore.destroyChat(sessionId)
  sessionStore.archiveSession(sessionId)
  if (!sessionStore.sessions.find((s) => !s.archived)) {
    const projStore = useProjectStore()
    sessionStore.createSession(null, { projectId: projStore.projects[0].id })
    chatStore.getOrCreateChat(sessionStore.sessions[0])
  }
  panelUI.setUndoToast('Session archived', [{ sessionId }])
  schedulePersist()
}

export function undoArchive() {
  const panelUI = usePanelUIStore()
  const toast = panelUI.undoToast
  if (!toast?.snapshots?.length) return
  for (const { sessionId } of toast.snapshots) {
    unarchiveSession(sessionId)
  }
  const firstId = toast.snapshots[0].sessionId
  if (firstId) selectSession(firstId)
  panelUI.clearUndoToast()
  schedulePersist()
}

const KEEP_STATUSES = new Set(['working', 'needs-approval', 'awaiting-review'])

export function cleanUpProject(projectId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()
  const toArchive = sessionStore.sessions.filter(
    (s) => !s.archived && s.projectId === projectId && !KEEP_STATUSES.has(sessionStatusKind(s)),
  )
  if (!toArchive.length) return
  const snapshots = []
  for (const session of toArchive) {
    flushChatToSession(session)
    chatStore.destroyChat(session.id)
    sessionStore.archiveSession(session.id)
    snapshots.push({ sessionId: session.id })
  }
  if (!sessionStore.sessions.find((s) => !s.archived)) {
    const projStore = useProjectStore()
    sessionStore.createSession(null, { projectId: projStore.projects[0].id })
    chatStore.getOrCreateChat(sessionStore.sessions[0])
  }
  panelUI.setUndoToast(`${snapshots.length} session${snapshots.length > 1 ? 's' : ''} archived`, snapshots)
  schedulePersist()
}

export async function restoreArchivedSession(projectId, sessionId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const session = await sessionStore.restoreArchivedSession(projectId, sessionId)
  if (session && session.type !== 'app') chatStore.getOrCreateChat(session)
  if (session) selectSession(session.id)
  schedulePersist()
  return session
}

export async function viewArchivedSession(projectId, sessionId) {
  const sessionStore = useSessionStore()
  const session = await sessionStore.loadArchivedSession(projectId, sessionId)
  if (!session) return null
  selectSession(session.id)
  return session
}

export async function permanentlyDeleteArchivedSession(projectId, sessionId) {
  const sessionStore = useSessionStore()
  await sessionStore.permanentlyDeleteArchived(projectId, sessionId)
}

export function lockActiveSessionToProject(projectId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const result = sessionStore.lockActiveSessionToProject(projectId)
  if (result) {
    chatStore.getOrCreateChat(result)
    indexActiveProjectFiles()
    schedulePersist()
  }
  return result
}

export function setActiveDraftProject(projectId) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const result = sessionStore.setActiveDraftProject(projectId)
  if (result) {
    chatStore.getOrCreateChat(result)
    indexActiveProjectFiles()
    schedulePersist()
  }
  return result
}

export async function createSessionWithChat(modelId, options) {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()
  panelUI.statusFilter = ''
  panelUI.closeProjectHome()
  await discardActiveUnstartedSession()
  const session = sessionStore.createSession(modelId, options)
  logAudit('session.create', {
    sessionId: session.id,
    projectId: session.projectId,
    modelId: modelId,
  })
  chatStore.getOrCreateChat(session)
  panelUI.pushHistory(session.id)
  panelUI.closeSidebarOnNarrow()
  return session
}

export async function forkFromMessage(sourceSessionId, messageIndex) {
  const sessionStore = useSessionStore()
  const source = sessionStore.sessions.find(s => s.id === sourceSessionId)
  if (!source) return null

  const chat = chatInstances.get(sourceSessionId)
  const rawMessages = chat
    ? chat.state.messagesRef.value.map(m => ({ ...m, parts: (m.parts || []).map(p => ({ ...p })) }))
    : source._savedMessages || []

  const sliced = rawMessages.slice(0, messageIndex + 1)
  const messages = cleanMessagesForPersist(sliced)

  const rawLabel = `Branch of ${source.label || 'Untitled'}`
  const label = rawLabel.length > 60 ? rawLabel.slice(0, 57) + '...' : rawLabel

  const newSession = await createSessionWithChat(source.modelId, {
    projectId: source.projectId,
    label,
    messages,
    lockProject: source.projectLocked,
  })

  newSession.skill = source.skill || null
  newSession.controlId = source.controlId

  logAudit('session.fork', {
    sessionId: newSession.id,
    sourceSessionId,
    messageIndex,
    projectId: newSession.projectId,
  })

  schedulePersist()
  return newSession
}

export async function discardActiveUnstartedSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const session = sessionStore.activeSession
  if (!session) return false
  if (session.type === 'app') return false
  if (session._userMessageSent || sessionStore.sessionMessageCount(session) > 0) return false

  chatStore.destroyChat(session.id)
  await sessionStore.deleteSession(session.id)
  schedulePersist()
  return true
}

// ---- Project actions ----

export function createProject() {
  const panelUI = usePanelUIStore()
  panelUI.openProjectDialog('new')
}

export async function openFolderProject() {
  const projStore = useProjectStore()
  const result = await projStore.openFolderProject()
  if (!result) return null
  return startProjectChat(result.id)
}

export async function linkFolderAsProject({ name, workspacePath }) {
  const projStore = useProjectStore()
  const panelUI = usePanelUIStore()
  const project = await projStore.linkFolderAsProject({ name, workspacePath })
  if (!project) return null
  logAudit('project.create', {
    projectId: project.id,
    name: project.name,
    workspacePath: project.workspacePath,
  })
  await startProjectChat(project.id, { label: 'New project chat' })
  schedulePersist()
  panelUI.showAddProjectDialog = false
  return project
}

export async function startProjectChat(projectId, options = {}) {
  const projStore = useProjectStore()
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()
  const project = projStore.projects.find((p) => p.id === projectId)
  if (!project) return null
  panelUI.statusFilter = ''
  panelUI.closeProjectHome()
  await discardActiveUnstartedSession()
  panelUI.newChatStartMode = options.mode || 'chat'
  projStore.expandProject(projectId)
  const session = sessionStore.createSession(null, {
    projectId,
    label: options.label || (options.mode === 'agent' ? 'New agent' : 'New chat'),
    lockProject: true,
    openChat: options.openChat,
    linkedEntries: options.linkedEntries,
  })
  chatStore.getOrCreateChat(session)
  panelUI.pushHistory(session.id)
  panelUI.closeSidebarOnNarrow()
  return session
}

export function startProjectAgent(projectId) {
  return startProjectChat(projectId, { mode: 'agent', label: 'New agent' })
}

export async function createDraftInProject(projectId) {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  const chatStore = useChatStore()
  const panelUI = usePanelUIStore()

  const existing = sessionStore.sessions.find(
    (s) => !s.archived && s.projectId === projectId && sessionStore.sessionMessageCount(s) === 0 && s.type !== 'app',
  )
  if (existing) {
    panelUI.closeProjectHome()
    sessionStore.selectSession(existing.id)
    chatStore.getOrCreateChat(existing)
    panelUI.pushHistory(existing.id)
    panelUI.closeSidebarOnNarrow()
    return existing
  }

  panelUI.statusFilter = ''
  panelUI.closeProjectHome()
  panelUI.newChatStartMode = 'chat'
  projStore.expandProject(projectId)
  const session = sessionStore.createSession(null, {
    projectId,
    label: 'New chat',
    lockProject: true,
  })
  logAudit('session.create', { sessionId: session.id, projectId })
  chatStore.getOrCreateChat(session)
  panelUI.pushHistory(session.id)
  panelUI.closeSidebarOnNarrow()
  schedulePersist()
  return session
}

export async function moveSessionToProject(sessionId, targetProjectId) {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  const session = sessionStore.sessions.find((s) => s.id === sessionId)
  if (!session) return false

  const kind = sessionStatusKind(session)
  if (kind === 'working' || kind === 'needs-approval') return false

  const hasPendingProposals = session.proposals?.some((p) => p.status === 'pending' || p.status === 'applying')
  if (hasPendingProposals) return false

  const oldProjectId = session.projectId
  session.projectId = targetProjectId
  session.linkedEntries = []
  session.updatedAt = new Date().toISOString()
  projStore.expandProject(targetProjectId)

  if (isTauri) {
    try {
      const { deleteSession: deleteFromDisk, saveSession: saveToDisk } = await import('../../services/dataDir')
      await deleteFromDisk(oldProjectId, sessionId)
      const { snapshotSession } = await import('./persistence.js')
      await saveToDisk(targetProjectId, snapshotSession(session))
    } catch {}
  }

  logAudit('session.move', { sessionId, from: oldProjectId, to: targetProjectId })
  schedulePersist()
  return true
}

export async function renameProject(projectId, newName) {
  const projStore = useProjectStore()
  await projStore.renameProject(projectId, newName)
  schedulePersist()
}

export async function removeProject(projectId) {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  // Orphan sessions to 'general' before removing the project
  const proj = projStore.projects.find(p => p.id === projectId)
  logAudit('project.remove', {
    projectId: projectId,
    name: proj?.name,
  })
  sessionStore.sessions
    .filter((s) => s.projectId === projectId)
    .forEach((s) => { s.projectId = 'general' })
  await projStore.removeProject(projectId)
  schedulePersist()
}

export async function indexActiveProjectFiles(explicitProjectId) {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  const project = explicitProjectId
    ? projStore.projects.find(p => p.id === explicitProjectId)
    : sessionStore.activeProject
  await projStore.indexProjectFiles(project?.workspacePath)
}

// ---- App actions ----

export async function launchApp(appId, projectId) {
  const appStore = useAppStore()
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  const panelUI = usePanelUIStore()

  const app = appStore.getApp(appId)
  if (!app) return null

  const resolvedProjectId = projectId || sessionStore.activeProject?.id || projStore.projects[0]?.id || 'general'

  panelUI.statusFilter = ''
  panelUI.closeProjectHome()

  await discardActiveUnstartedSession()

  const hasSetup = app.setup && Array.isArray(app.setup.fields) && app.setup.fields.length > 0
  const session = sessionStore.createSession(null, {
    projectId: resolvedProjectId,
    label: app.name,
    lockProject: true,
    type: 'app',
    appId: app.id,
    appName: app.name,
    appStatus: hasSetup ? 'setup' : 'ready',
    appEvents: [],
  })

  appStore.trackUsage(appId)
  sessionStore.selectSession(session.id)
  telemetryEmit('app.launch', { appId: app.id })
  projStore.expandProject(resolvedProjectId)
  panelUI.pushHistory(session.id)
  panelUI.closeSidebarOnNarrow()
  schedulePersist()

  return session
}
