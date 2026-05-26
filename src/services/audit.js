import { fromAudit } from './telemetry.js'

const isTauri = () => !!window.__TAURI_INTERNALS__

export async function logAudit(eventType, { projectId, sessionId, actor, ...payload } = {}) {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('audit_log', {
      eventType,
      projectId: projectId || null,
      sessionId: sessionId || null,
      actor: actor || 'user',
      payload: Object.keys(payload).length ? JSON.stringify(payload) : null,
    })
  } catch (e) {
    console.warn('[audit] log failed:', e)
  }
  // Telemetry tap — always runs, never throws
  try { fromAudit(eventType, payload) } catch {}
}

export function groupIntoEpisodes(events) {
  if (!events.length) return []

  const episodes = []
  let current = null

  for (const event of events) {
    const isAiRelated = event.event_type.startsWith('ai.') || event.event_type.startsWith('tool.')

    if (current && isAiRelated && event.session_id === current.sessionId) {
      const gap = Math.abs(new Date(current.lastTimestamp) - new Date(event.timestamp))
      if (gap <= 60000) {
        current.events.push(event)
        current.lastTimestamp = event.timestamp
        continue
      }
    }

    if (current) {
      current.summary = buildEpisodeSummary(current.events)
      episodes.push(current)
    }

    current = {
      id: event.id,
      timestamp: event.timestamp,
      lastTimestamp: event.timestamp,
      sessionId: event.session_id,
      events: [event],
      summary: '',
    }
  }

  if (current) {
    current.summary = buildEpisodeSummary(current.events)
    episodes.push(current)
  }

  return episodes
}

function buildEpisodeSummary(events) {
  const types = events.map(e => e.event_type)

  if (types.includes('ai.request')) {
    const tools = events
      .filter(e => e.event_type === 'tool.execute')
      .map(e => {
        try { return JSON.parse(e.payload || '{}').toolName || 'tool' }
        catch { return 'tool' }
      })

    const hasApproval = events.some(e => {
      try { return JSON.parse(e.payload || '{}').approvalDecision === 'user_approved' }
      catch { return false }
    })

    let summary = 'AI interaction'
    if (tools.length) summary = `AI used ${tools.join(', ')}`
    if (hasApproval) summary += ' (user-approved)'
    return summary
  }

  const first = events[0]
  if (first.event_type === 'session.create') return 'Session created'
  if (first.event_type === 'session.archive') return 'Session archived'
  if (first.event_type === 'session.delete') return 'Session deleted'
  if (first.event_type === 'project.create') return 'Project created'
  if (first.event_type === 'project.remove') return 'Project removed'
  if (first.event_type === 'export.run') {
    try {
      const p = JSON.parse(first.payload || '{}')
      return `Exported as ${p.format || 'document'}`
    } catch { return 'Document exported' }
  }

  return first.event_type.replace(/\./g, ' ')
}

export async function queryAudit({ projectId, eventTypes, from, to, limit } = {}) {
  if (!isTauri()) return []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke('audit_query', {
      projectId: projectId || null,
      eventTypes: eventTypes || null,
      from: from || null,
      to: to || null,
      limit: limit || null,
    })
  } catch (e) {
    console.warn('[audit] query failed:', e)
    return []
  }
}

export async function queryAuditSummary({ projectId, from, to } = {}) {
  if (!isTauri()) return { total_events: 0, by_type: [] }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke('audit_query_summary', {
      projectId: projectId || null,
      from: from || null,
      to: to || null,
    })
  } catch (e) {
    console.warn('[audit] summary query failed:', e)
    return { total_events: 0, by_type: [] }
  }
}

export async function exportAuditCsv({ projectId, from, to } = {}) {
  if (!isTauri()) return ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke('audit_export_csv', {
      projectId: projectId || null,
      from: from || null,
      to: to || null,
    })
  } catch (e) {
    console.warn('[audit] export failed:', e)
    return ''
  }
}

export function relativeTime(isoString) {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diff = now - then

  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 172800000) return 'yesterday'
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function getTimeGroup(isoString) {
  const now = new Date()
  const then = new Date(isoString)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart - 86400000)
  const weekStart = new Date(todayStart - 6 * 86400000)

  if (then >= todayStart) return 'Today'
  if (then >= yesterdayStart) return 'Yesterday'
  if (then >= weekStart) return 'This Week'
  return 'Earlier'
}
