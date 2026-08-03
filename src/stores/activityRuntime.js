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
  writeActivity,
  clearActivity,
  closeActivity,
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
  let nextArchiveMutation = 0
  const archiveMutations = new Map()
  const resumePromises = new Map()

  function upsertBackendRecord(record) {
    return activities.upsert(canonicalBackendRecord(record))
  }

  async function initialize() {
    if (ready.value) return
    error.value = ''
    try {
      unlisten = await listenToActivityEvents(onEvent)
      for (const record of await listActivities()) upsertBackendRecord(record)
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
    const workspaceScope = presetWorkspaceScope(preset)
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
      autoTitleEligible: kind === 'agent' && !options.title,
      workspacePath: workspaceScope === 'workspace' ? workspacePath : '',
      status: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      retention: options.retention || (kind === 'terminal' ? 'ephemeral' : 'durable'),
      source: {
        launcherId: resolved.agentId || resolved.presetId,
        presetId: resolved.presetId,
        ...(options.source || {}),
        workspaceScope,
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
    if (typeof options.beforeSpawn === 'function') {
      await options.beforeSpawn(record)
    }
    const snapshot = await spawnActivity(record, {}, resolved.cliSessionId || null)
    const seedInput = String(options.seedInput || '').replace(/[\r\n]+/g, ' ')
    if (seedInput) await writeActivity(snapshot.record.id, seedInput)
    const spawnedAt = monotonicNow()
    upsertBackendRecord(snapshot.record)
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
  function resumePreset(preset, activity) {
    const existing = resumePromises.get(activity.id)
    if (existing) return existing
    const promise = resumePresetExact(preset, activity)
      .finally(() => resumePromises.delete(activity.id))
    resumePromises.set(activity.id, promise)
    return promise
  }

  async function resumePresetExact(preset, activity) {
    const startedAt = monotonicNow()
    const resolved = await resolveLauncher(preset, activity.workspacePath)
    const resolvedAt = monotonicNow()
    const workspaceScope = normalizedWorkspaceScope(
      activity.source?.workspaceScope,
      presetWorkspaceScope(preset),
    )
    const resumeStrategy = normalizedResumeStrategy(
      activity.host?.resumeStrategy || resolved.resumeStrategy,
    )
    const cliSessionId = String(activity.session?.cliSessionId || '').trim()
    if (!cliSessionId) {
      throw new Error(
        'This Activity has no exact provider session id. Its transcript can be restored, but it cannot be resumed safely.',
      )
    }
    const recordedAgentId = String(
      activity.session?.agentId || activity.source?.launcherId || '',
    ).trim()
    const resolvedAgentId = String(resolved.agentId || resolved.presetId || '').trim()
    const resolvedStrategy = normalizedResumeStrategy(resolved.resumeStrategy)
    if (
      (recordedAgentId && resolvedAgentId && recordedAgentId !== resolvedAgentId)
      || (resolvedStrategy !== 'none' && resumeStrategy !== resolvedStrategy)
    ) {
      throw new Error(
        `This Activity belongs to ${recordedAgentId || resumeStrategy}, but its launcher now resolves to ${resolvedAgentId || resolvedStrategy}.`,
      )
    }
    const agentId = resolved.agentId || resolved.presetId
    const baseMcpUrl = resolved.env?.MIMIR_MCP_URL || 'http://127.0.0.1:17532/mcp'
    const mcpUrl = activityContextUrl(baseMcpUrl, {
      activityId: activity.id,
      agentId,
    })
    // A continuation keeps the launch policy of the session it belongs to.
    // Resolving the launcher again supplies the current executable and identity,
    // but must not silently replace the recorded model, permission, or tool flags.
    const recordedArgs = Array.isArray(activity.launch?.args)
      ? activity.launch.args
      : resolved.args
    const recordedMcpUrl = activity.launch?.env?.MIMIR_MCP_URL || baseMcpUrl
    const record = {
      ...activity,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      archivedAt: undefined,
      session: undefined,
      error: undefined,
      workspacePath: workspaceScope === 'workspace' ? activity.workspacePath : '',
      source: {
        ...(activity.source || {}),
        workspaceScope,
      },
      host: {
        type: 'pty',
        ...(resumeStrategy !== 'none'
          ? { resumeStrategy }
          : {}),
      },
      launch: {
        command: resolved.command,
        args: exactResumeArguments(recordedArgs, resumeStrategy, cliSessionId)
          .map(argument => replaceMcpUrl(argument, recordedMcpUrl, mcpUrl)),
        cwd: resolved.cwd,
        env: {
          ...(activity.launch?.env || {}),
          ...(resolved.env || {}),
          MIMIR_ACTIVITY_ID: activity.id,
          MIMIR_AGENT_ID: agentId,
          MIMIR_MCP_URL: mcpUrl,
        },
      },
    }
    const snapshot = await respawnActivity(record, {}, cliSessionId)
    const spawnedAt = monotonicNow()
    upsertBackendRecord(snapshot.record)
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
    workspacePath = '',
    open = true,
  }) {
    if (!command) throw new Error('A command is required.')
    if (!cwd) throw new Error('A working directory is required.')
    const id = `${kind}:${crypto.randomUUID()}`
    const timestamp = new Date().toISOString()
    const workspaceScope = normalizedWorkspaceScope(
      source.workspaceScope,
      workspacePath ? 'workspace' : 'global',
    )
    const record = {
      id,
      kind,
      title: title || command,
      workspacePath: workspaceScope === 'workspace' ? (workspacePath || cwd) : '',
      status: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      retention,
      source: { ...source, workspaceScope },
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
    upsertBackendRecord(snapshot.record)
    if (open) workbench.openActivity(id)
    return snapshot.record
  }

  async function stop(id) {
    await stopActivity(id)
  }

  async function close(id) {
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      return activities.setArchived(id, true)
    }
    const record = await closeActivity(id)
    return upsertBackendRecord(record)
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
    upsertBackendRecord(await renameActivity(id, title))
  }

  async function setArchived(id, archived) {
    const generation = ++nextArchiveMutation
    archiveMutations.set(id, generation)
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      return activities.setArchived(id, archived)
    }
    const record = await setActivityArchived(id, archived)
    // The backend also publishes an upsert event. If a user restores a row as
    // soon as the archive event arrives, the older archive invoke can resolve
    // after the newer restore and must not overwrite the restored renderer
    // state with its stale response.
    const canonical = canonicalBackendRecord(record)
    if (archiveMutations.get(id) === generation) activities.upsert(canonical)
    return activities.byId(id) || canonical
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
      upsertBackendRecord(event.record)
      return
    }
    if (event.type === 'status' && activities.byId(event.activityId)) {
      activities.reconcileStatus(event.activityId, event.status)
      return
    }
    if (event.type === 'exit' && event.record) {
      upsertBackendRecord(event.record)
    }
  }

  async function dispose() {
    if (unlisten) unlisten()
    unlisten = null
    archiveMutations.clear()
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
    close,
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

function canonicalBackendRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  // Rust omits Option::None fields. Activity records are otherwise merged with
  // existing renderer state, so an omitted archivedAt must be made explicit or
  // a restored Activity retains its previous archive timestamp forever.
  return {
    ...record,
    autoTitleEligible: Boolean(record.autoTitleEligible),
    archivedAt: record.archivedAt ?? null,
    closeRequestedAt: record.closeRequestedAt ?? null,
  }
}

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
  const candidates = [...new Set([
    original,
    'http://127.0.0.1:17532/mcp',
  ].filter(Boolean))]
  const candidate = candidates.find(value => argument.includes(String(value)))
  return candidate
    ? argument.replaceAll(String(candidate), replacement)
    : argument
}

export function exactResumeArguments(args = [], strategy = 'none', cliSessionId = '') {
  const sessionId = String(cliSessionId || '').trim()
  if (!sessionId) throw new Error('An exact provider session id is required to resume.')

  let current = [...args]
  if (strategy === 'codex') {
    if (current[0] === 'resume') {
      current.shift()
      if (current[0] === '--last' || (current[0] && !current[0].startsWith('-'))) {
        current.shift()
      }
    }
    current = current.filter(argument => argument !== '--last')
    return ['resume', sessionId, ...codexGlobalArguments(current)]
  }
  if (strategy === 'claude') {
    current = withoutOptions(current, ['--session-id', '--resume'])
      .filter(argument => !['--continue', '-c'].includes(argument))
    return ['--resume', sessionId, ...current]
  }
  if (strategy === 'pi') {
    current = withoutOptions(current, ['--session-id', '--session'])
      .filter(argument => !['--continue', '-c'].includes(argument))
    return ['--session', sessionId, ...current]
  }
  if (strategy === 'gemini') {
    current = withoutOptions(current, ['--session-id', '--resume', '-r'])
    return ['--resume', sessionId, ...current]
  }
  throw new Error('This launcher does not support exact session resume.')
}

function codexGlobalArguments(args) {
  const flags = new Set([
    '--yolo',
    '--full-auto',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--search',
    '--oss',
    '--no-alt-screen',
    '--strict-config',
  ])
  const valued = new Set([
    '-c',
    '--config',
    '-m',
    '--model',
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '-C',
    '--cd',
    '--add-dir',
    '--enable',
    '--disable',
    '--remote',
    '--remote-auth-token-env',
    '--local-provider',
    '-p',
    '--profile',
  ])
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (flags.has(argument)) {
      result.push(argument)
      continue
    }
    const inline = [...valued].find(option => argument.startsWith(`${option}=`))
    if (inline) {
      result.push(argument)
      continue
    }
    if (valued.has(argument) && index + 1 < args.length) {
      result.push(argument, args[index + 1])
      index += 1
    }
  }
  return result
}

function withoutOptions(args, options) {
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const option = options.find(candidate => (
      argument === candidate || argument.startsWith(`${candidate}=`)
    ))
    if (!option) {
      result.push(argument)
      continue
    }
    if (argument === option) index += 1
  }
  return result
}

function normalizedResumeStrategy(value) {
  return ['codex', 'claude', 'pi', 'gemini'].includes(value) ? value : 'none'
}

function presetWorkspaceScope(preset) {
  return ['home', 'custom'].includes(preset?.cwd?.mode) ? 'global' : 'workspace'
}

function normalizedWorkspaceScope(value, fallback) {
  return value === 'workspace' || value === 'global' ? value : fallback
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}
