import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  listActivities,
  listenToActivityEvents,
  resolveLauncher,
  renameActivity,
  respawnActivity,
  setActivityArchived,
  spawnActivity,
  stopActivity,
  clearActivity,
} from '../services/activities.js'
import { useActivitiesStore } from './activities.js'
import { useWorkbenchStore } from './workbench.js'

export const useActivityRuntimeStore = defineStore('activityRuntime', () => {
  const activities = useActivitiesStore()
  const workbench = useWorkbenchStore()
  const ready = ref(false)
  const error = ref('')
  const lastLaunchMetrics = ref(null)
  let unlisten = null

  async function initialize() {
    if (ready.value) return
    error.value = ''
    try {
      unlisten = await listenToActivityEvents(onEvent)
      for (const record of await listActivities()) activities.upsert(record)
      ready.value = true
    } catch (cause) {
      error.value = message(cause)
      throw cause
    }
  }

  async function launchPreset(preset, workspacePath, options = {}) {
    const startedAt = monotonicNow()
    const resolved = await resolveLauncher(preset, workspacePath)
    const resolvedAt = monotonicNow()
    const kind = options.kind || resolved.kind
    const resumeStrategy = normalizedResumeStrategy(resolved.resumeStrategy)
    const id = `${kind}:${crypto.randomUUID()}`
    const timestamp = new Date().toISOString()
    const mcpUrl = activityContextUrl(
      resolved.env?.MIMIR_MCP_URL || 'http://127.0.0.1:17532/mcp',
      {
        activityId: id,
        agentId: resolved.agentId || resolved.presetId,
      },
    )
    const record = {
      id,
      kind,
      title: options.title || resolved.title,
      workspacePath: resolved.cwd,
      status: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      retention: options.retention || (kind === 'terminal' ? 'ephemeral' : 'durable'),
      source: {
        launcherId: resolved.agentId || resolved.presetId,
        presetId: resolved.presetId,
        ...(options.source || {}),
      },
      host: {
        type: 'pty',
        ...(resumeStrategy !== 'none'
          ? { resumeStrategy }
          : {}),
      },
      launch: {
        command: resolved.command,
        args: [...resolved.args, ...(options.args || [])]
          .map(argument => replaceMcpUrl(argument, resolved.env?.MIMIR_MCP_URL, mcpUrl)),
        cwd: resolved.cwd,
        env: {
          ...(resolved.env || {}),
          ...(options.env || {}),
          MIMIR_ACTIVITY_ID: id,
          MIMIR_AGENT_ID: resolved.agentId || resolved.presetId,
          MIMIR_MCP_URL: mcpUrl,
        },
      },
    }
    const snapshot = await spawnActivity(record)
    const spawnedAt = monotonicNow()
    activities.upsert(snapshot.record)
    if (options.open !== false) workbench.openActivity(id)
    recordLaunchMetrics({
      presetId: resolved.presetId,
      kind,
      resolveMs: resolvedAt - startedAt,
      spawnMs: spawnedAt - resolvedAt,
      totalMs: spawnedAt - startedAt,
    })
    return snapshot.record
  }

  // Resume continues the interrupted agent inside its existing Activity row.
  // The backend respawn preserves the record id and creation time; only the
  // launch spec, session, and scrollback restart.
  async function resumePreset(preset, activity) {
    const startedAt = monotonicNow()
    const resolved = await resolveLauncher(preset, activity.workspacePath)
    const resolvedAt = monotonicNow()
    const resumeStrategy = normalizedResumeStrategy(
      activity.host?.resumeStrategy || resolved.resumeStrategy,
    )
    const record = {
      ...activity,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      archivedAt: undefined,
      session: undefined,
      error: undefined,
      workspacePath: resolved.cwd,
      host: {
        type: 'pty',
        ...(resumeStrategy !== 'none'
          ? { resumeStrategy }
          : {}),
      },
      launch: {
        command: resolved.command,
        args: resumeArguments(resolved.args, resumeStrategy),
        cwd: resolved.cwd,
        env: {
          ...(resolved.env || {}),
          MIMIR_ACTIVITY_ID: activity.id,
          MIMIR_MCP_URL: 'http://127.0.0.1:17532/mcp',
        },
      },
    }
    const snapshot = await respawnActivity(record)
    const spawnedAt = monotonicNow()
    activities.upsert(snapshot.record)
    workbench.openActivity(activity.id)
    recordLaunchMetrics({
      presetId: resolved.presetId,
      kind: activity.kind,
      resolveMs: resolvedAt - startedAt,
      spawnMs: spawnedAt - resolvedAt,
      totalMs: spawnedAt - startedAt,
    })
    return snapshot.record
  }

  async function launchCommand({
    title,
    command,
    args = [],
    cwd,
    env = {},
    kind = 'terminal',
    retention = 'durable',
    source = {},
    open = true,
  }) {
    if (!command) throw new Error('A command is required.')
    if (!cwd) throw new Error('A working directory is required.')
    const id = `${kind}:${crypto.randomUUID()}`
    const timestamp = new Date().toISOString()
    const record = {
      id,
      kind,
      title: title || command,
      workspacePath: cwd,
      status: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      retention,
      source,
      host: { type: 'pty' },
      launch: {
        command,
        args,
        cwd,
        env: {
          ...env,
          MIMIR_ACTIVITY_ID: id,
          MIMIR_MCP_URL: 'http://127.0.0.1:17532/mcp',
        },
      },
    }
    const snapshot = await spawnActivity(record)
    activities.upsert(snapshot.record)
    if (open) workbench.openActivity(id)
    return snapshot.record
  }

  async function stop(id) {
    await stopActivity(id)
  }

  async function rename(id, title) {
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      activities.upsert({
        ...activity,
        title,
        updatedAt: new Date().toISOString(),
      })
      return
    }
    activities.upsert(await renameActivity(id, title))
  }

  async function setArchived(id, archived) {
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      activities.setArchived(id, archived)
      return
    }
    activities.upsert(await setActivityArchived(id, archived))
  }

  async function clear(id) {
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      activities.remove(id)
      return
    }
    await clearActivity(id)
    activities.remove(id)
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'upsert' && event.record) {
      activities.upsert(event.record)
      return
    }
    if (event.type === 'status' && activities.byId(event.activityId)) {
      activities.reconcileStatus(event.activityId, event.status)
      return
    }
    if (event.type === 'exit' && event.record) {
      activities.upsert(event.record)
    }
  }

  async function dispose() {
    if (unlisten) unlisten()
    unlisten = null
    ready.value = false
  }

  return {
    ready,
    error,
    lastLaunchMetrics,
    initialize,
    launchPreset,
    resumePreset,
    launchCommand,
    stop,
    rename,
    setArchived,
    clear,
    dispose,
  }

  function recordLaunchMetrics(metrics) {
    const rounded = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
      key,
      typeof value === 'number' ? Math.round(value * 10) / 10 : value,
    ]))
    lastLaunchMetrics.value = rounded
    try {
      performance.measure('mimir.activity.launch', {
        start: performance.now() - metrics.totalMs,
        end: performance.now(),
        detail: rounded,
      })
    } catch {
      // The reactive metric remains available in WebViews without MeasureOptions.
    }
  }
})

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Activity runtime failed.')
}

export function activityContextUrl(value, context = {}) {
  const fallback = 'http://127.0.0.1:17532/mcp'
  try {
    const url = new URL(String(value || fallback))
    for (const [key, entry] of Object.entries(context)) {
      if (entry) url.searchParams.set(key, String(entry))
    }
    return url.toString()
  } catch {
    return fallback
  }
}

function replaceMcpUrl(argument, original, replacement) {
  if (typeof argument !== 'string' || !replacement) return argument
  const candidates = [
    original,
    'http://127.0.0.1:17532/mcp',
  ].filter(Boolean)
  return candidates.reduce(
    (value, candidate) => value.replaceAll(String(candidate), replacement),
    argument,
  )
}

export function resumeArguments(args = [], strategy = 'none') {
  const current = [...args]
  if (strategy === 'codex') {
    if (current[0] === 'resume') return current
    return ['resume', '--last', ...current]
  }
  if (strategy === 'claude' || strategy === 'pi') {
    if (current.includes('--continue') || current.includes('-c')) return current
    return ['--continue', ...current]
  }
  return current
}

function normalizedResumeStrategy(value) {
  return ['codex', 'claude', 'pi'].includes(value) ? value : 'none'
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}
