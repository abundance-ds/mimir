// Persistence module — coordinates across all panel stores.
// NOT a Pinia store — just exported functions.

import { watch, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getAiKeyStatus, getModelRegistry } from '../../services/ai/client'
import { normalizeModelId } from '../../services/ai/modelControls'
import {
  bootstrapDataDir,
  listProjects,
  saveProjectMeta,
  saveSession as saveToDisk,
  loadSession as loadFromDisk,
  listSessionMetas,
  loadSettings,
  saveSettings,
} from '../../services/dataDir'
import {
  chatInstances,
  emptyUsage,
  plainJson,
  cleanMessagesForPersist,
} from './helpers.js'
import { wrapHfu } from '../../shared/hfu.js'
import { usePanelUIStore } from './ui.js'
import { useProjectStore } from './projects.js'
import { useSessionStore } from './sessions.js'
import { useChatStore } from './chat.js'
import { useBoardStore } from './board.js'

const STORAGE_KEY = 'shoulders:panel:sessions:v1'
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// F4: Concurrent persist guard
let _persistRunning = false
let _persistQueued = false
let _persistTimer = null

// Skip-unchanged cache: only write sessions/projects whose JSON actually changed
const _lastPersistedSession = new Map()
const _lastPersistedProject = new Map()

// ---- Persist ----

export function schedulePersist() {
  const panelUI = usePanelUIStore()
  if (!panelUI.storageReady) return
  window.clearTimeout(_persistTimer)
  _persistTimer = window.setTimeout(() => persistNow(), 500)
}

export function persistNow() {
  const snapshot = buildSnapshot()
  if (isTauri) {
    persistToDisk(snapshot)
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
}

export function buildSnapshot() {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  return {
    version: 1,
    activeSessionId: sessionStore.activeSessionId,
    expandedProjectIds: projStore.expandedProjectIds,
    projectOrder: projStore.projects.map((p) => p.id),
    sessionOrder: sessionStore.sessionOrder,
    projects: projStore.projects,
    sessions: sessionStore.sessions.map(snapshotSession),
  }
}

export function snapshotSession(session) {
  const chat = chatInstances.get(session.id)
  const rawMessages = chat
    ? chat.state.messagesRef.value.map((m) => ({ ...m, parts: (m.parts || []).map((p) => ({ ...p })) }))
    : session._savedMessages || []
  const messages = cleanMessagesForPersist(rawMessages)
  return {
    id: session.id,
    projectId: session.projectId,
    label: session.label,
    modelId: session.modelId,
    controlId: session.controlId,
    proposals: plainJson(session.proposals),
    usage: { ...session.usage },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastViewedAt: session.lastViewedAt,
    archived: session.archived,
    pinned: Boolean(session.pinned),
    projectLocked: Boolean(session.projectLocked),
    lastError: session.lastError,
    messages,
    type: session.type || 'chat',
    skill: session.skill || null,
    appId: session.appId || null,
    appName: session.appName || null,
    appStatus: session.appStatus || null,
    appEvents: session.appEvents ? plainJson(session.appEvents) : null,
    appResult: session.appResult ? plainJson(session.appResult) : null,
    appError: session.appError || null,
    appInputs: session.appInputs ? plainJson(session.appInputs) : null,
    appStartedAt: session.appStartedAt || null,
    appCompletedAt: session.appCompletedAt || null,
    lastInputTokens: session.lastInputTokens || 0,
    linkedEntries: Array.isArray(session.linkedEntries) ? session.linkedEntries : [],
  }
}

async function persistToDisk(snapshot) {
  if (_persistRunning) {
    _persistQueued = true
    return
  }
  _persistRunning = true
  try {
    for (const project of snapshot.projects) {
      const json = JSON.stringify(project)
      if (json !== _lastPersistedProject.get(project.id)) {
        await saveProjectMeta(project)
        _lastPersistedProject.set(project.id, json)
      }
    }
    for (const session of snapshot.sessions) {
      const json = JSON.stringify(session)
      if (json !== _lastPersistedSession.get(session.id)) {
        await saveToDisk(session.projectId || 'general', session)
        _lastPersistedSession.set(session.id, json)
      }
    }
    const existing = await loadSettings()
    existing.activeSessionId = snapshot.activeSessionId
    existing.expandedProjectIds = snapshot.expandedProjectIds
    existing.projectOrder = snapshot.projectOrder
    existing.sessionOrder = snapshot.sessionOrder
    await saveSettings(existing)
  } catch (error) {
    console.warn('[panel] Could not persist to disk:', error)
  } finally {
    _persistRunning = false
    if (_persistQueued) {
      _persistQueued = false
      persistNow()
    }
  }
}

// ---- Restore ----

async function restoreFromDisk() {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  try {
    await bootstrapDataDir()
    const prefs = await loadSettings()
    const diskProjects = await listProjects()
    if (diskProjects.length) {
      projStore.projects = projStore.orderProjects(projStore.mergeProjects(diskProjects), prefs.projectOrder)
    }
    projStore.expandedProjectIds = projStore.projects.map((p) => p.id)

    const allSessions = []
    const archivedMetasList = []
    for (const project of projStore.projects) {
      const metas = await listSessionMetas(project.id)
      for (const meta of metas) {
        if (meta.archived) {
          archivedMetasList.push(meta)
          continue
        }
        try {
          const full = await loadFromDisk(project.id, meta.id)
          allSessions.push({
            id: full.id,
            projectId: full.projectId || project.id,
            label: full.label || 'Untitled',
            modelId: normalizeModelId(full.modelId) || '',
            controlId: full.controlId || '',
            proposals: Array.isArray(full.proposals) ? full.proposals : [],
            usage: { ...emptyUsage(), ...(full.usage || {}) },
            createdAt: full.createdAt || new Date().toISOString(),
            updatedAt: full.updatedAt || full.createdAt || new Date().toISOString(),
            lastViewedAt: full.lastViewedAt || full.updatedAt || new Date().toISOString(),
            archived: false,
            pinned: Boolean(full.pinned),
            projectLocked: Boolean(full.projectLocked),
            lastError: '',
            lastInputTokens: full.lastInputTokens || 0,
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
            linkedEntries: Array.isArray(full.linkedEntries) ? full.linkedEntries : [],
          })
        } catch { /* skip unreadable sessions */ }
      }
    }
    const seen = new Set()
    sessionStore.sessions = allSessions.filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })

    sessionStore.sessions.forEach((s) => {
      if (s.projectId === 'current-draft') s.projectId = 'general'
    })

    // Migrate "General" display name → "Personal"
    const generalProject = projStore.projects.find((p) => p.id === 'general')
    if (generalProject && generalProject.name === 'General') generalProject.name = 'Personal'

    sessionStore.archivedMetas = archivedMetasList
    sessionStore.activeSessionId = prefs.activeSessionId || sessionStore.sessions.find((s) => !s.archived)?.id || ''
    if (Array.isArray(prefs.expandedProjectIds)) {
      projStore.expandedProjectIds = prefs.expandedProjectIds
    }
    if (prefs.sessionOrder && typeof prefs.sessionOrder === 'object') {
      sessionStore.sessionOrder = prefs.sessionOrder
    }
  } catch (error) {
    console.warn('[panel] Could not restore from disk:', error)
  }
}

function restoreFromLocalStorage() {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!raw || raw.version !== 1) return
    projStore.projects = projStore.orderProjects(projStore.mergeProjects(raw.projects), raw.projectOrder)
    projStore.expandedProjectIds = Array.isArray(raw.expandedProjectIds) ? raw.expandedProjectIds : projStore.projects.map((p) => p.id)
    sessionStore.sessions = Array.isArray(raw.sessions)
      ? raw.sessions.map((s) => ({
          id: s.id,
          projectId: s.projectId || 'general',
          label: s.label || 'Untitled',
          modelId: normalizeModelId(s.modelId) || '',
          controlId: s.controlId || '',
          proposals: Array.isArray(s.proposals) ? s.proposals : [],
          usage: { ...emptyUsage(), ...(s.usage || {}) },
          createdAt: s.createdAt || new Date().toISOString(),
          updatedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
          lastViewedAt: s.lastViewedAt || s.updatedAt || new Date().toISOString(),
          archived: Boolean(s.archived),
          pinned: Boolean(s.pinned),
          projectLocked: Boolean(s.projectLocked),
          lastError: '',
          _savedMessages: Array.isArray(s.messages) ? s.messages : [],
          type: s.type || 'chat',
          appId: s.appId || null,
          appName: s.appName || null,
          appStatus: s.appStatus || null,
          appEvents: Array.isArray(s.appEvents) ? s.appEvents : null,
          appResult: s.appResult || null,
          appError: s.appError || null,
          appInputs: s.appInputs || null,
          appStartedAt: s.appStartedAt || null,
          appCompletedAt: s.appCompletedAt || null,
          linkedEntries: Array.isArray(s.linkedEntries) ? s.linkedEntries : [],
        }))
      : []
    sessionStore.sessions.forEach((s) => {
      if (s.projectId === 'current-draft') s.projectId = 'general'
    })

    const generalProject = projStore.projects.find((p) => p.id === 'general')
    if (generalProject && generalProject.name === 'General') generalProject.name = 'Personal'

    sessionStore.activeSessionId = raw.activeSessionId || sessionStore.sessions.find((s) => !s.archived)?.id || ''
    if (raw.sessionOrder && typeof raw.sessionOrder === 'object') {
      sessionStore.sessionOrder = raw.sessionOrder
    }
  } catch (error) {
    console.warn('[panel] Could not restore state:', error)
  }
}

// ---- Theme ----

export function applyThemeFromSettings() {
  if (isTauri) {
    loadSettings().then((settings) => {
      document.documentElement.setAttribute('data-theme', settings?.editor?.editorTheme || 'parchment')
    }).catch(() => {
      document.documentElement.setAttribute('data-theme', 'parchment')
    })
  } else {
    const theme = localStorage.getItem('shoulders:theme') || 'parchment'
    document.documentElement.setAttribute('data-theme', theme)
    window.addEventListener('storage', (e) => {
      if (e.key === 'shoulders:theme' && e.newValue) {
        document.documentElement.setAttribute('data-theme', e.newValue)
      }
    })
  }
}

// ---- Master init ----

export async function initializePanelStores() {
  const panelUI = usePanelUIStore()
  const projStore = useProjectStore()
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  // 1. Theme
  applyThemeFromSettings()

  // 2. Restore data
  if (isTauri) {
    await restoreFromDisk()

    // Seed skills/apps from build profile
    try {
      const { ensureSkillsDir, seedDefaultSkills, seedSkillFromResource } = await import('../../services/skills/loader.js')
      const { seedAppFromResource } = await import('../../services/apps/seeder.js')
      const { BUNDLED_SKILLS } = await import('../../services/skills/bundled.js')
      await ensureSkillsDir()

      let bundleSkillIds = BUNDLED_SKILLS.map(s => s.id)
      try {
        const json = await invoke('read_bundled_profile')
        const profile = JSON.parse(json)
        if (profile.bundleSkills) bundleSkillIds = profile.bundleSkills
      } catch { /* dev mode — no profile, seed all defaults */ }

      await seedDefaultSkills(BUNDLED_SKILLS.filter(s => bundleSkillIds.includes(s.id)))

      try {
        const resourceSkills = await invoke('list_bundled_skills')
        for (const { id, content } of resourceSkills) {
          await seedSkillFromResource(id, content)
        }
      } catch { /* no bundled-skills resource */ }

      try {
        const resourceApps = await invoke('list_bundled_apps')
        for (const app of resourceApps) {
          await seedAppFromResource(app)
        }
      } catch { /* no bundled-apps resource */ }

      const { useSkillsStore } = await import('./skills.js')
      useSkillsStore().refreshSkills()
    } catch (err) {
      console.warn('[panel] Skill seeding failed:', err)
    }
  } else {
    restoreFromLocalStorage()
  }

  // 3. Load AI registry and key statuses
  try {
    sessionStore.registry = await getModelRegistry()
    sessionStore.keyStatuses = await getAiKeyStatus()
  } catch (error) {
    console.warn('[panel] AI registry unavailable:', error)
    sessionStore.registry = { models: [], providers: {} }
    sessionStore.keyStatuses = []
  }

  // 4. Normalize session models
  sessionStore.normalizeSessionModels()

  // 5. Create initial session if needed
  if (!sessionStore.sessions.some((s) => !s.archived)) {
    sessionStore.createSession(null, { openChat: false })
  }
  if (!sessionStore.activeSessionId && sessionStore.sessions[0]) {
    sessionStore.activeSessionId = sessionStore.sessions[0].id
  }

  // 6. Create Chat instances for all sessions (skip app sessions)
  sessionStore.sessions.forEach((s) => {
    if (!s.archived && s.type !== 'app') chatStore.getOrCreateChat(s)
  })

  // 6b. Reset zombie "applying" proposals (app crashed mid-apply) and sync to Rust
  for (const s of sessionStore.sessions) {
    for (const p of s.proposals || []) {
      if (p.status === 'applying') p.status = 'pending'
    }
  }
  sessionStore.syncProposalsToRust()

  // 7. Mark storage ready
  panelUI.storageReady = true

  // 8. Index project files
  await indexActiveProjectFiles()

  // 9. Tauri event listeners
  if (isTauri) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('shoulders://proposal-result', (event) => {
        const result = event.payload
        const proposal = sessionStore.findProposalById(result.id)
        if (!proposal) return
        if (result.status === 'applied') {
          sessionStore.setProposalStatus(proposal, 'accepted')
        } else if (result.status === 'rejected') {
          sessionStore.setProposalStatus(proposal, 'rejected')
        } else if (result.status === 'stale' || result.status === 'conflict') {
          sessionStore.setProposalStatus(proposal, result.status, result.detail || 'Proposal no longer applies cleanly')
        } else {
          sessionStore.setProposalStatus(proposal, 'failed', result.detail || 'Apply failed')
        }
      })
      listen('shoulders://proposals-state', (event) => {
        const proposals = Array.isArray(event.payload) ? event.payload : []
        for (const proposal of proposals) {
          sessionStore.upsertProposalFromCoordinator(proposal)
        }
      })
      listen('shoulders://theme-changed', (event) => {
        const theme = event.payload?.theme || 'parchment'
        document.documentElement.setAttribute('data-theme', theme)
      })
      listen('shoulders://board-changed', () => {
        const boardStore = useBoardStore()
        if (boardStore.activeProjectId) boardStore.loadBoard(boardStore.activeProjectId)
      })
      listen('shoulders://document-changed', (event) => {
        const payload = event.payload
        if (payload && typeof payload.content === 'string') {
          chatStore._documentContext = { content: payload.content, path: payload.path || '' }
        }
      })
      listen('shoulders://board-send-to-agent', async (event) => {
        const { filePath, entryId } = event.payload || {}
        if (!entryId) return

        const existing = sessionStore.sessions.find(
          (s) => !s.archived && (s.linkedEntries || []).includes(entryId),
        )
        let session = null
        if (existing) {
          sessionStore.selectSession(existing.id)
          const projStore = useProjectStore()
          projStore.expandProject(existing.projectId)
          session = existing
        } else {
          const projStore = useProjectStore()
          const project = projStore.findProjectByFilePath(filePath) || sessionStore.activeProject || projStore.projects[0]
          if (!project) return
          const { startProjectChat } = await import('./actions.js')
          session = await startProjectChat(project.id, {
            label: `Issue: ${entryId}`,
            linkedEntries: [entryId],
          })
        }
        if (!session) return
        const chat = chatStore.getOrCreateChat(session)
        chat._pendingComposerPrefill = `@board/${entryId} `
        panelUI.pushHistory(session.id)
        schedulePersist()
      })
      listen('shoulders://comments-submit', async (event) => {
        const { filePath, comments, documentContent, target } = event.payload || {}
        if (!comments?.length) return
        const projStore = useProjectStore()
        const fallbackProject = projStore.findProjectByFilePath(filePath) || sessionStore.activeProject || projStore.projects[0]
        const fileName = filePath?.split('/').pop() || 'the document'
        let session = null

        if (target?.type === 'session' && target.sessionId) {
          session = sessionStore.sessions.find((s) => !s.archived && s.id === target.sessionId) || null
          if (session) {
            sessionStore.selectSession(session.id)
            projStore.expandProject(session.projectId)
            chatStore.getOrCreateChat(session)
            panelUI.pushHistory(session.id)
          }
        }

        if (!session) {
          const requestedProject = projStore.projects.find((p) => p.id === target?.projectId)
          const project = requestedProject || fallbackProject
          const { startProjectChat } = await import('./actions.js')
          session = await startProjectChat(project.id, { label: `Review: ${fileName}` })
        }

        if (!session) return
        const text = formatCommentsMessage(comments, fileName, documentContent)
        await nextTick()
        chatStore.sendMessage(text)
        schedulePersist()
      })
    })
  }

  // 10. Watch session changes for auto-persist
  watch(
    () => sessionStore.sessions.map((s) => `${s.id}|${s.label}|${s.modelId}|${s.updatedAt}|${s.archived}|${s.appStatus || ''}`).join(','),
    () => schedulePersist(),
  )

  // 11. beforeunload handler
  window.addEventListener('beforeunload', () => {
    if (panelUI.storageReady) {
      window.clearTimeout(_persistTimer)
      if (!isTauri) {
        persistNow()
      }
    }
  })

  // 12. Watch activeProject AND projectHome for re-indexing
  watch(
    () => sessionStore.activeProject,
    () => indexActiveProjectFiles(),
  )
  watch(
    () => panelUI.projectHomeId,
    (id) => { if (id) indexActiveProjectFiles(id) },
  )
}

export function formatCommentsMessage(comments, fileName, documentContent) {
  const instruction = `Please address the ${comments.length} review comment${comments.length > 1 ? 's' : ''} on "${fileName}".`
  if (documentContent) {
    return `${instruction} The document with inline comments follows:\n\n${wrapHfu(documentContent)}`
  }
  return `${instruction} Use read("@editor", { show_comments: true }) to see them in context.`
}

async function indexActiveProjectFiles(explicitProjectId) {
  const sessionStore = useSessionStore()
  const projStore = useProjectStore()
  const project = explicitProjectId
    ? projStore.projects.find(p => p.id === explicitProjectId)
    : sessionStore.activeProject
  await projStore.indexProjectFiles(project?.workspacePath)
}
