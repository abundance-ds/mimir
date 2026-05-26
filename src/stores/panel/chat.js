import { Chat } from '@ai-sdk/vue'
import { generateText, lastAssistantMessageIsCompleteWithToolCalls, tool } from 'ai'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { createShouldersChatTransport } from '../../services/ai/chatTransport'
import { useSkillsStore } from './skills.js'
import { addUsage, createSdkModel, buildProviderOptions } from '../../services/ai/sdkAdapter'
import { recoverPoisonedMessages } from '../../services/ai/recovery'
import { chatInstances, readHistories, proposalFinal, pendingApprovalMap, sanitizeLoadedMessages } from './helpers.js'
import { clearSessionAllowList } from '../../services/ai/tools/gate.js'
import { toFileUIParts } from '../../services/attachments.js'
import { stripHfu, wrapHfu } from '../../shared/hfu.js'
import { useSessionStore } from './sessions.js'
import { useProjectStore } from './projects.js'
import { usePanelUIStore } from './ui.js'
import { useSettingsStore } from '../settings.js'
import { emit as telemetryEmit } from '../../services/telemetry.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const approvalQueues = new Map()

function createApprovalHandler(sessionId) {
  return (name, args, meta) => {
    return new Promise((resolve) => {
      const entry = { toolName: name, args: args || {}, meta: meta || {}, resolve }
      const queue = approvalQueues.get(sessionId) || []
      queue.push(entry)
      approvalQueues.set(sessionId, queue)
      if (queue.length === 1) {
        const next = new Map(pendingApprovalMap.value)
        next.set(sessionId, entry)
        pendingApprovalMap.value = next
      }
    })
  }
}

export const useChatStore = defineStore('panelChat', () => {
  const _chatVersion = ref(0)
  const _documentContext = ref({ content: '', path: '' })
  const _pendingComposerPrefill = ref('')

  // ---- Budget state ----

  const budgetWarningThreshold = 0.8
  const _budgetState = ref({ cost: 0, limit: 0, checked: false })

  const isBudgetWarning = computed(() => {
    const { cost, limit, checked } = _budgetState.value
    return checked && limit > 0 && cost >= limit * budgetWarningThreshold && cost < limit
  })

  const isBudgetBlocked = computed(() => {
    const { cost, limit, checked } = _budgetState.value
    return checked && limit > 0 && cost >= limit
  })

  // ---- Context window state ----

  const isContextBlocked = computed(() => {
    const sessionStore = useSessionStore()
    const session = sessionStore.activeSession
    if (!session?.lastInputTokens) return false
    const model = sessionStore.concreteModelForSession(session)
    if (!model?.contextWindow) return false
    return session.lastInputTokens >= model.contextWindow
  })

  // ---- Chat instance management ----

  function getOrCreateChat(session) {
    if (chatInstances.has(session.id)) return chatInstances.get(session.id)

    const chat = new Chat({
      id: session.id,
      messages: sanitizeLoadedMessages(session._savedMessages || []),
      transport: createShouldersChatTransport(() => buildChatConfig(session)),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onError(error) {
        session.lastError = error?.message || String(error)
        session.updatedAt = new Date().toISOString()
        recoverPoisonedMessages(chat, error)
        console.error('[panel]', error)
      },
      onFinish() {
        session.lastError = ''
        session.updatedAt = new Date().toISOString()
      },
    })

    chatInstances.set(session.id, chat)
    _chatVersion.value++

    watch(
      () => chat.state.statusRef.value,
      (newStatus, oldStatus) => {
        if (newStatus === 'ready' && (oldStatus === 'streaming' || oldStatus === 'submitted')) {
          session.updatedAt = new Date().toISOString()
          // Schedule persist via dynamic import to avoid circular deps
          import('./persistence.js').then(({ schedulePersist }) => schedulePersist())
          autoGenerateTitle(session, chat)
        }
      },
    )

    return chat
  }

  function getChatInstance(sessionId) {
    void _chatVersion.value
    return chatInstances.get(sessionId) || null
  }

  function destroyChat(sessionId) {
    const chat = chatInstances.get(sessionId)
    if (chat) {
      try { chat.stop() } catch {}
      chatInstances.delete(sessionId)
      readHistories.delete(sessionId)
      clearSessionAllowList()
      resolveApproval(sessionId, { approved: false, alwaysAllow: false }, true)
      _chatVersion.value++
    }
  }

  function getOrCreateReadHistory(sessionId) {
    if (!readHistories.has(sessionId)) readHistories.set(sessionId, new Set())
    return readHistories.get(sessionId)
  }

  // ---- Active chat computed ----

  const activeChat = computed(() => {
    const sessionStore = useSessionStore()
    const session = sessionStore.activeSession
    return session ? getChatInstance(session.id) : null
  })

  const activeMessages = computed(() => {
    const chat = activeChat.value
    return chat ? chat.state.messagesRef.value : []
  })

  const activeStatus = computed(() => {
    const chat = activeChat.value
    return chat ? chat.state.statusRef.value : 'ready'
  })

  const activeError = computed(() => {
    const chat = activeChat.value
    const sessionStore = useSessionStore()
    const chatErr = chat ? chat.state.errorRef.value : null
    return chatErr?.message || sessionStore.activeSession?.lastError || ''
  })

  const isActiveBusy = computed(() =>
    ['submitted', 'streaming'].includes(activeStatus.value),
  )

  const canSend = computed(() => {
    const sessionStore = useSessionStore()
    return Boolean(
      sessionStore.activeSession && !isActiveBusy.value && !isContextBlocked.value && sessionStore.canUseSessionModel(sessionStore.activeSession),
    )
  })

  const composerStatus = computed(() => {
    const sessionStore = useSessionStore()
    if (activeError.value) return 'Needs attention'
    const session = sessionStore.activeSession
    if (session && pendingApprovalMap.value.has(session.id)) return 'Needs approval'
    if (isActiveBusy.value) return 'Working'
    if (!sessionStore.canUseSessionModel(session)) return 'Add API key'
    if (session?.proposals.some((p) => !proposalFinal(p))) return 'Awaiting review'
    return 'Ready'
  })

  // ---- Actions ----

  async function sendMessage(text, attachments) {
    const sessionStore = useSessionStore()
    const session = sessionStore.activeSession
    if (!session || !text.trim() || isActiveBusy.value || !sessionStore.canUseSessionModel(session)) return

    if (session.archived) {
      sessionStore.unarchiveSession(session.id)
      import('./persistence.js').then(({ schedulePersist }) => schedulePersist())
    }

    session._userMessageSent = true

    const budgetOk = await checkBudget()
    if (!budgetOk) {
      session.lastError = `Monthly budget limit reached ($${_budgetState.value.cost.toFixed(2)} / $${_budgetState.value.limit.toFixed(2)}). Increase the budget in settings to continue.`
      return
    }

    const chat = getOrCreateChat(session)
    if (activeMessages.value.length === 0) {
      const labelText = stripHfu(text)
      session.label = labelText.length > 46 ? `${labelText.slice(0, 43)}...` : labelText
    }
    session.lastError = ''
    session.updatedAt = new Date().toISOString()

    // Separate text attachments from binary attachments
    const textParts = (attachments || []).filter(a => a.type === 'text')
    const binaryParts = (attachments || []).filter(a => a.type !== 'text')

    let fullText = text.trim()
    if (textParts.length) {
      const prefix = textParts.map(t => wrapHfu(`<attached-file name="${t.filename}">\n${t.content}\n</attached-file>`)).join('\n\n')
      fullText = prefix + '\n\n' + fullText
    }

    const msg = { text: fullText }
    const files = toFileUIParts(binaryParts)
    if (files.length) msg.files = files
    chat.sendMessage(msg)
    telemetryEmit('chat.send')
  }

  function stopActiveSession() {
    const sessionStore = useSessionStore()
    const session = sessionStore.activeSession
    if (session) resolveApproval(session.id, { approved: false, alwaysAllow: false }, true)
    const chat = activeChat.value
    if (chat) chat.stop()
  }

  async function regenerateLastResponse() {
    const sessionStore = useSessionStore()
    const session = sessionStore.activeSession
    if (!session || isActiveBusy.value) return
    const chat = getChatInstance(session.id)
    if (!chat) return
    session.lastError = ''
    session.updatedAt = new Date().toISOString()
    chat.regenerate()
  }

  function getDocumentContext() {
    const ctx = _documentContext.value
    if (ctx.content) return { content: ctx.content, path: ctx.path }
    const content = localStorage.getItem('shoulders:doc') || ''
    const path = localStorage.getItem('shoulders:doc:path') || ''
    return { content, path }
  }

  function buildToolPolicy(session) {
    const projStore = useProjectStore()
    const project = projStore.projects.find((p) => p.id === session?.projectId)
    const policy = {}
    if (project?._toolWhitelist) policy.toolWhitelist = project._toolWhitelist
    return policy
  }

  async function buildChatConfig(session) {
    const sessionStore = useSessionStore()
    const projStore = useProjectStore()
    const settingsStore = useSettingsStore()
    const model = sessionStore.concreteModelForSession(session)
    const projectPath = projStore.resolveProjectPath(session.projectId)
    const config = {
      registry: sessionStore.registry,
      modelId: model?.id || session.modelId,
      controlId: sessionStore.currentControl(session).id,
      threadId: session.id,
      maxSteps: resolveSkillConfig(session, 'maxSteps'),
      maxOutputTokens: resolveSkillConfig(session, 'maxOutputTokens'),
      toolContext: {
        sessionId: session.id,
        projectId: session.projectId,
        projectPath,
        disabledTools: resolveDisabledTools(session, settingsStore, projStore),
        approvalMode: resolveApprovalMode(session, settingsStore, projStore),
        _readHistory: getOrCreateReadHistory(session.id),
        getDocument: () => getDocumentContext(),
        onApprovalRequest: createApprovalHandler(session.id),
        policy: buildToolPolicy(session),
        linkEntry(entryId) {
          if (!session.linkedEntries) session.linkedEntries = []
          if (!session.linkedEntries.includes(entryId)) session.linkedEntries.push(entryId)
        },
        onProposal(proposal) {
          const enriched = {
            ...proposal,
            threadId: session.id,
            status: proposal.status || 'pending',
            path: proposal.path || 'current-document.md',
          }
          sessionStore.upsertProposalFromCoordinator(enriched)
          if (isTauri) {
            import('@tauri-apps/api/core')
              .then(({ invoke }) => invoke('proposal_create', { proposal: enriched }))
              .catch(() => {})
          }
          session.updatedAt = new Date().toISOString()
        },
      },
      onUsage(usage, modelConfig) {
        session.usage = addUsage(session.usage, usage)
        session.lastInputTokens = usage.inputTokens || 0
        if (isTauri) recordUsage(usage, modelConfig, session.id)
      },
    }

    // G1-G4: Read project-level config files if workspace is linked
    if (projectPath && isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')

        // G3: Project prompt (AGENTS.md in workspace root — shared/team)
        try {
          if (await invoke('path_exists', { path: `${projectPath}/AGENTS.md` })) {
            const { content } = await invoke('read_text_file', { path: `${projectPath}/AGENTS.md` })
            if (content?.trim()) config.projectSystemPrompt = content.trim()
          }
        } catch {}

        // G4: Personal instructions (~/.shoulders-v3/projects/{id}/instructions.md — local only)
        try {
          const { projectDir } = await import('../../services/dataDir')
          const personalPath = `${await projectDir(session.projectId)}/instructions.md`
          if (await invoke('path_exists', { path: personalPath })) {
            const { content } = await invoke('read_text_file', { path: personalPath })
            if (content?.trim()) config.projectInstructions = content.trim()
          }
        } catch {}

        // G1: Workspace meta context
        try {
          const fileTree = await invoke('list_dir', { path: projectPath })
          const references = await readProjectReferences()
          let gitStatus = null
          try { gitStatus = await invoke('git_status', { path: projectPath }) } catch {}
          config.workspaceMeta = {
            workspacePath: projectPath,
            fileTree,
            references,
            gitStatus,
          }
        } catch {}
      } catch {}
    }

    // Skill prompt injection — only when user explicitly selected a skill
    const skillsStore = useSkillsStore()
    if (session.skill) {
      try { config.skillPrompt = await skillsStore.getSkillPrompt(session.skill) } catch {}
    }

    // Skill catalog for progressive disclosure
    const disabledSkills = settingsStore.disabledSkills || []
    config.skillCatalog = skillsStore.skills
      .filter(s => !disabledSkills.includes(s.id))
      .map(s => ({ id: s.id, name: s.name, description: s.description }))

    try {
      const { useBoardStore } = await import('./board.js')
      const boardStore = useBoardStore()
      if (boardStore.activeProjectId === session.projectId && boardStore.entries.length > 0) {
        config.boardContext = boardStore.buildBoardContext()
      }
    } catch {}

    return config
  }

  async function readProjectReferences() {
    if (!isTauri) return []
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke('ref_list')
    } catch { return [] }
  }

  // ---- Auto-title generation ----

  function autoGenerateTitle(session, chat) {
    if (session._aiTitle || !isTauri) return
    const msgs = chat.state.messagesRef.value
    const userMsgs = msgs.filter((m) => m.role === 'user')
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant')
    if (userMsgs.length !== 1 || assistantMsgs.length < 1) return

    session._aiTitle = true
    _doGenerateTitle(session, userMsgs[0], assistantMsgs[0]).catch((e) => {
      session._aiTitle = false
      console.warn('[panel] Title generation failed:', e)
    })
  }

  async function _doGenerateTitle(session, userMsg, assistantMsg) {
    const { z } = await import('zod')
    const sessionStore = useSessionStore()
    const userText = extractPartsText(userMsg.parts).slice(0, 300)
    const assistantText = extractPartsText(assistantMsg.parts).slice(0, 200)
    if (!userText) return

    const { model, modelConfig } = await createSdkModel({
      feature: 'extract',
      correlationPrefix: 'title',
    })

    const providerOptions = {}
    if (modelConfig.provider === 'anthropic') {
      providerOptions.anthropic = { thinking: { type: 'disabled' } }
    }

    const result = await generateText({
      model,
      maxOutputTokens: 150,
      temperature: 0.2,
      providerOptions,
      system: 'Generate a concise title and search keywords for this conversation. Call the set_title tool with your result.',
      prompt: `User: ${userText}\n\nAssistant: ${assistantText}`,
      tools: {
        set_title: tool({
          description: 'Set the conversation title and search keywords',
          inputSchema: z.object({
            title: z.string().describe('Concise title, 3-8 words, no trailing punctuation'),
            keywords: z.array(z.string()).describe('3-5 search keywords'),
          }),
        }),
      },
      toolChoice: { type: 'tool', toolName: 'set_title' },
    })

    const call = result.toolCalls?.[0]
    if (!call?.input?.title) return

    const current = sessionStore.sessions.find((s) => s.id === session.id)
    if (!current) return
    current.label = call.input.title.trim().slice(0, 60)
    current._aiTitle = true
    current.keywords = Array.isArray(call.input.keywords) ? call.input.keywords : []
    import('./persistence.js').then(({ schedulePersist }) => schedulePersist())
  }

  function extractPartsText(parts) {
    if (!parts) return ''
    return parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text || '')
      .join(' ')
      .trim()
  }

  // ---- Budget ----

  async function checkBudget() {
    if (!isTauri) return true
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const month = new Date().toISOString().slice(0, 7)
      const [monthData, limitRaw] = await Promise.all([
        invoke('usage_query_month', { month }),
        invoke('usage_get_setting', { key: 'budget_limit' }),
      ])
      const cost = monthData?.total_cost || 0
      const limit = parseFloat(limitRaw) || 0
      _budgetState.value = { cost, limit, checked: true }

      if (limit > 0 && cost >= limit) return false
      return true
    } catch (e) {
      console.warn('[panel] Budget check failed:', e)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const failMode = await invoke('usage_get_setting', { key: 'budget_fail_mode' }).catch(() => 'open')
        if (failMode === 'closed') return false
      } catch {}
      return true
    }
  }

  function getPendingApproval(sessionId) {
    return pendingApprovalMap.value.get(sessionId) || null
  }

  function resolveApproval(sessionId, result, all = false) {
    const queue = approvalQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    if (all) {
      for (const e of queue) e.resolve(result)
      queue.length = 0
    } else {
      queue[0].resolve(result)
      queue.shift()
    }
    const next = new Map(pendingApprovalMap.value)
    if (queue.length > 0) {
      next.set(sessionId, queue[0])
    } else {
      next.delete(sessionId)
      approvalQueues.delete(sessionId)
    }
    pendingApprovalMap.value = next
  }

  return {
    _chatVersion,
    _documentContext,
    _pendingComposerPrefill,
    _budgetState,
    isBudgetWarning,
    isBudgetBlocked,
    isContextBlocked,
    getOrCreateChat,
    getChatInstance,
    destroyChat,
    getOrCreateReadHistory,
    activeChat,
    activeMessages,
    activeStatus,
    activeError,
    isActiveBusy,
    canSend,
    composerStatus,
    sendMessage,
    stopActiveSession,
    regenerateLastResponse,
    getDocumentContext,
    buildChatConfig,
    readProjectReferences,
    autoGenerateTitle,
    extractPartsText,
    checkBudget,
    getPendingApproval,
    resolveApproval,
  }
})

// ---- Per-project permission resolution ----

export function resolveSkillConfig(session, field) {
  const defaults = { maxSteps: 8, maxOutputTokens: 1800 }
  const projectDefaults = { maxSteps: 12, maxOutputTokens: 16000 }
  if (session.skill) {
    const meta = useSkillsStore().getSkillMeta(session.skill)
    if (meta?.[field]) return meta[field]
  }
  if (session.projectId) return projectDefaults[field]
  return defaults[field]
}

function resolveApprovalMode(session, settingsStore, projStore) {
  const project = projStore.projects.find(p => p.id === session?.projectId)
  const projectMode = project?.approvalMode
  if (projectMode && projectMode !== 'default') return projectMode
  return settingsStore.aiApprovalMode || 'normal'
}

function resolveDisabledTools(session, settingsStore, projStore) {
  const project = projStore.projects.find(p => p.id === session?.projectId)
  const globalDisabled = settingsStore.disabledTools || []
  const projectDisabled = project?.disabledTools
  if (!Array.isArray(projectDisabled)) return globalDisabled
  const merged = new Set([...globalDisabled, ...projectDisabled])
  return [...merged]
}

// ---- Usage recording (private, only called from buildChatConfig onUsage) ----

async function recordUsage(usage, modelConfig, sessionId) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('usage_record', {
      feature: 'chat',
      provider: modelConfig?.provider || 'unknown',
      model: modelConfig?.id || 'unknown',
      inputTokens: usage.inputNoCacheTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheRead: usage.cacheReadInputTokens || 0,
      cacheWrite: usage.cacheWriteInputTokens || 0,
      cost: usage.estimatedCost || 0,
      sessionId: sessionId || null,
    })
  } catch (e) {
    console.warn('[panel] usage_record failed:', e)
  }
}
