// Pure helper functions extracted from usePanelStore.
// chatInstances and readHistories live here as module-level Maps so that
// chatMessages / chatStatus / chatErrorMessage can access them directly.

import { ref } from 'vue'
import { basename } from '../../shared/utils/path.js'

export { basename }

export const chatInstances = new Map()
export const readHistories = new Map()

// Pending approval tracking — reactive so sessionStatusKind recomputes.
// Map<sessionId, { toolName, args, meta, resolve }>
export const pendingApprovalMap = ref(new Map())

const TOOL_OUTPUT_MAX_LENGTH = 2000

// ---- Chat accessors ----

export function chatMessages(session) {
  const chat = chatInstances.get(session?.id)
  if (!chat) return session?._savedMessages || []
  return chat.state.messagesRef.value
}

export function chatStatus(session) {
  const chat = chatInstances.get(session?.id)
  if (!chat) return 'ready'
  return chat.state.statusRef.value
}

export function chatErrorMessage(session) {
  const chat = chatInstances.get(session?.id)
  if (!chat) return ''
  return chat.state.errorRef.value?.message || ''
}

// ---- Session status helpers ----

export function isUnread(session) {
  if (!session.lastViewedAt) return false
  if (chatStatus(session) !== 'ready') return false
  const msgs = chatMessages(session)
  if (msgs.length === 0) return false
  return new Date(session.updatedAt) > new Date(session.lastViewedAt)
}

export function isAppSession(session) {
  return session?.type === 'app'
}

export function sessionStatusKind(session) {
  if (isAppSession(session)) {
    if (session.appStatus === 'running') return 'working'
    if (session.appStatus === 'failed') return 'error'
    if (session.appStatus === 'completed') return 'done'
    if (session.appStatus === 'aborted') return 'done'
    if (session.appStatus === 'setup') return 'ready'
    return 'ready'
  }
  if (session.lastError || chatErrorMessage(session)) return 'error'
  if (pendingApprovalMap.value.has(session?.id)) return 'needs-approval'
  if (session.proposals?.some((p) => !proposalFinal(p))) return 'awaiting-review'
  if (['submitted', 'streaming'].includes(chatStatus(session))) return 'working'
  if (isUnread(session)) return 'unread'
  if (chatMessages(session).length > 0) return 'done'
  return 'ready'
}

export function sessionStatusLabel(session) {
  const kind = sessionStatusKind(session)
  if (kind === 'working') return 'Working'
  if (kind === 'needs-approval') return 'Needs approval'
  if (kind === 'awaiting-review') return 'Awaiting review'
  if (kind === 'unread') return 'New response'
  if (kind === 'done') return 'Completed'
  if (kind === 'error') return 'Error'
  return 'Ready'
}

// ---- Session metadata ----

export function sessionMeta(session) {
  if (isAppSession(session)) {
    const steps = (session.appEvents || []).filter(e => e.type === 'step').length
    return `${steps} step${steps !== 1 ? 's' : ''}${session.appName ? ' · ' + session.appName : ''}`
  }
  const msgs = chatMessages(session).length
  const tools = countToolCalls(session)
  return `${msgs} Msg${tools ? `  ${tools} tool calls` : ''}`
}

export function countToolCalls(session) {
  return chatMessages(session).reduce((n, m) => n + (m.parts || []).filter(isToolPart).length, 0)
}

// ---- Proposal helpers ----

export function isToolPart(part) {
  return part?.type?.startsWith('tool-') || part?.type === 'dynamic-tool'
}

// ---- Tool display metadata ----

const TOOL_LABELS = {
  read: 'Read',
  list: 'List',
  search: 'Search',
  edit: 'Edit',
  create: 'Create',
  comment_add: 'Comment',
  comment_reply: 'Reply',
  search_web: 'Search Web',
  annotate_docx: 'Annotate DOCX',
  show: 'Show',
  shell: 'Shell',
}

export function getToolLabel(name) {
  return TOOL_LABELS[name] || name
}

export function getToolIcon(name) {
  switch (name) {
    case 'read':
      return 'eye'
    case 'list':
      return 'list'
    case 'search':
      return 'search'
    case 'edit':
      return 'pencil'
    case 'create':
      return 'file-plus'
    case 'comment_add':
    case 'comment_reply':
      return 'message-circle'
    case 'search_web':
      return 'globe'
    case 'annotate_docx':
      return 'file-text'
    case 'show':
      return 'layout'
    case 'shell':
      return 'terminal'
    default:
      return 'file'
  }
}

export function getToolContext(name, input) {
  if (!input) return ''
  switch (name) {
    case 'read':
    case 'list':
    case 'edit':
    case 'create':
    case 'annotate_docx':
    case 'show':
      return input.target ? basename(input.target) : ''
    case 'search':
      return input.query || input.scope || ''
    case 'search_web':
      return input.query || ''
    case 'comment_add':
      return input.anchor_text ? input.anchor_text.slice(0, 40) : ''
    case 'comment_reply':
      return input.comment_id || ''
    case 'shell':
      return input.command ? input.command.slice(0, 60) : ''
    default:
      return ''
  }
}

const FILE_TOOLS = new Set(['read', 'list', 'edit', 'create'])

export function getToolFilePath(name, input) {
  if (!FILE_TOOLS.has(name)) return null
  const p = input?.target || input?.path
  if (!p) return null
  return p
}

export function isSkillTool(name) {
  return false
}

export function proposalFinal(proposal) {
  return ['accepted', 'rejected', 'failed', 'stale', 'conflict'].includes(proposal.status)
}

export function proposalRetryable(proposal) {
  return ['failed', 'stale', 'conflict'].includes(proposal.status)
}

// ---- Formatting ----

export function relativeTime(value) {
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return 'now'
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatCost(value) {
  const c = Number(value) || 0
  if (c <= 0) return '$0.00'
  if (c < 0.01) return '<$0.01'
  return `$${c.toFixed(2)}`
}

// ---- Attention / sorting ----

export function attentionWeight(kind) {
  if (kind === 'error') return 100
  if (kind === 'needs-approval') return 95
  if (kind === 'awaiting-review') return 90
  if (kind === 'awaiting-input') return 70
  if (kind === 'working') return 60
  return 0
}

// ---- Serialization / data helpers ----

export function plainJson(value) {
  return JSON.parse(JSON.stringify(value || []))
}

export function plainProject(project) {
  if (!project) return null
  return {
    id: project.id,
    name: (project.name || '').trim() || 'Untitled Project',
    path: project.path || '',
    workspacePath: project.workspacePath || null,
    description: project.description || '',
    system: Boolean(project.system),
    createdAt: project.createdAt || null,
  }
}

export function emptyUsage() {
  return {
    inputTokens: 0, inputNoCacheTokens: 0, cachedInputTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCost: 0,
  }
}

export function defaultProjects() {
  return [
    { id: 'general', name: 'Personal', path: 'Personal chats', createdAt: '2026-05-10T00:00:00.000Z', system: true },
  ]
}

function isTerminalState(state) {
  return state === 'output-available' || state === 'output-error'
}

function isObjectInput(input) {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function toolToText(p) {
  return { type: 'text', text: `[Tool call: ${p.toolName || 'unknown'}${p.errorText ? ` — ${p.errorText}` : ''}]` }
}

export function sanitizeLoadedMessages(messages) {
  if (!Array.isArray(messages)) return []
  for (const msg of messages) {
    if (!msg.parts) continue
    if (msg.role === 'user') {
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        const p = msg.parts[i]
        if (p.type === 'file' && !p.url) {
          msg.parts[i] = { type: 'text', text: `[Attached: ${p.filename || 'file'}]` }
        }
      }
      continue
    }
    if (msg.role !== 'assistant') continue
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const p = msg.parts[i]
      if (!isToolPart(p)) continue
      if (!isTerminalState(p.state) || !isObjectInput(p.input) || !p.toolCallId) {
        msg.parts[i] = toolToText(p)
      }
    }
  }
  return messages
}

export function cleanMessagesForPersist(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((msg) => {
    if (!msg.parts || msg.role !== 'assistant') return msg
    const cleanedParts = []
    for (const part of msg.parts) {
      if (!isToolPart(part)) { cleanedParts.push(part); continue }
      if (!isTerminalState(part.state) || !isObjectInput(part.input) || !part.toolCallId) continue
      const cleaned = { ...part }
      delete cleaned.rawInput
      if (cleaned.output !== undefined) {
        let serialized
        try { serialized = JSON.stringify(cleaned.output) } catch { serialized = '' }
        if (serialized.length > TOOL_OUTPUT_MAX_LENGTH) {
          cleaned.output = { _truncated: true, _truncatedAt: new Date().toISOString(), preview: serialized.slice(0, 200) }
        }
      }
      cleanedParts.push(cleaned)
    }
    return { ...msg, parts: cleanedParts }
  })
}
