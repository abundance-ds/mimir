import { clearSessionPathAllows as _clearPathAllows, revokeSessionPathAllow as _revokePathAllow, getSessionPathAllows as _getPathAllows } from './pathPermission'
import { logAudit } from '../../audit.js'

const isTauri = () => !!window.__TAURI_INTERNALS__

const TOOL_META = {
  read:            { category: 'read',   risk: 'low' },
  list:            { category: 'read',   risk: 'low' },
  search:          { category: 'read',   risk: 'low' },
  edit:            { category: 'write',  risk: 'medium' },
  create:          { category: 'write',  risk: 'medium' },
  comment_add:     { category: 'write',  risk: 'low' },
  comment_reply:   { category: 'write',  risk: 'low' },
  search_web:      { category: 'online', risk: 'low' },
  annotate_docx:   { category: 'write',  risk: 'medium' },
  show:            { category: 'ui',     risk: 'low' },
  shell:           { category: 'system', risk: 'high', approval: true },
}

const sessionAllowList = new Set()
const MAX_OUTPUT_CHARS = 48_000

const CATEGORY_LABELS = {
  read: 'Read',
  write: 'Write',
  online: 'Online',
  system: 'System',
  ui: 'Interface',
}

export function registerTool() {}

export function getToolMeta(name) {
  const meta = TOOL_META[name]
  if (!meta) return { category: 'general', label: name, risk: 'low', approval: false }
  return { ...meta, label: meta.label || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }
}

export function getToolCategories() {
  const groups = new Map()
  for (const [name, meta] of Object.entries(TOOL_META)) {
    const cat = meta.category
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push({ name, ...getToolMeta(name) })
  }
  return [...groups.entries()].map(([id, tools]) => ({
    id,
    label: CATEGORY_LABELS[id] || id,
    tools,
  }))
}

export function clearSessionAllowList() {
  sessionAllowList.clear()
}

export function revokeSessionToolAllow(toolName) {
  sessionAllowList.delete(toolName)
}

export function getSessionToolAllows() {
  return [...sessionAllowList]
}

export function clearSessionPathAllows(sessionId) {
  _clearPathAllows(sessionId)
}

export function revokeSessionPathAllow(sessionId, dirPath) {
  _revokePathAllow(sessionId, dirPath)
}

export function getSessionPathAllows(sessionId) {
  return _getPathAllows(sessionId)
}

export function withGate(name, executeFn, context = {}) {
  const meta = getToolMeta(name)
  return async (args, sdkOptions) => {
    const mode = context.approvalMode || 'normal'

    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return { error: `Tool '${name}' received invalid arguments: expected an object, got ${typeof args}.`, blocked: true }
    }

    if (Array.isArray(context.policy?.toolWhitelist) && !context.policy.toolWhitelist.includes(name)) {
      return { error: 'Tool not available in this project.', blocked: true }
    }

    // Legacy policy block check (all modes)
    if (context.policy?.isBlocked?.(name)) {
      return { error: `Tool '${name}' is blocked by policy.`, blocked: true }
    }

    let approvalDecision = 'auto'
    if (mode !== 'bypass') {
      const needsApproval = mode === 'strict' || meta.approval
      if (needsApproval && !sessionAllowList.has(name) && context.onApprovalRequest) {
        const result = await context.onApprovalRequest(name, args, { ...meta, toolCallId: sdkOptions?.toolCallId })
        if (result?.alwaysAllow) {
          sessionAllowList.add(name)
          approvalDecision = 'user_approved'
        } else if (!result?.approved) {
          logAudit('tool.execute', {
            sessionId: context.sessionId,
            toolName: name,
            category: meta.category,
            risk: meta.risk,
            approvalDecision: 'user_denied',
            success: false,
          })
          return { error: 'Tool execution was declined by the user.', blocked: true }
        } else {
          approvalDecision = 'user_approved'
        }
      }
    }

    const start = Date.now()
    try {
      let result = await executeFn(args)

      result = enforceOutputSize(result)

      logExecution(name, meta, context.sessionId, Date.now() - start, true)
      logAudit('tool.execute', {
        sessionId: context.sessionId,
        toolName: name,
        category: meta.category,
        mutating: meta.mutating,
        risk: meta.risk,
        approvalDecision,
        durationMs: Date.now() - start,
        success: true,
      })
      return result
    } catch (err) {
      logExecution(name, meta, context.sessionId, Date.now() - start, false, err.message)
      logAudit('tool.execute', {
        sessionId: context.sessionId,
        toolName: name,
        category: meta.category,
        risk: meta.risk,
        approvalDecision,
        durationMs: Date.now() - start,
        success: false,
        error: err.message,
      })
      throw err
    }
  }
}

function enforceOutputSize(result) {
  if (typeof result === 'string' && result.length > MAX_OUTPUT_CHARS) {
    return result.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Truncated]'
  }
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.length > MAX_OUTPUT_CHARS) {
    return { ...result, content: result.content.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Truncated]' }
  }
  return result
}

async function logExecution(toolName, meta, sessionId, durationMs, success, errorMessage) {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('tool_execution_record', {
      toolName,
      category: meta.category,
      mutating: meta.mutating,
      risk: meta.risk,
      sessionId: sessionId || null,
      durationMs,
      success,
      errorMessage: errorMessage || null,
    })
  } catch (e) {
    console.warn('[tools] audit log failed:', e)
  }
}
