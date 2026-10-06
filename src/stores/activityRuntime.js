import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  listActivities,
  activitySnapshot,
  prepareActivityWorkspaceMove,
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
import { canMoveActivityWorkspace } from '../mimir/activityWorkspace.js'

const AUTOMATIC_RESTORE_READY_TIMEOUT_MS = 45_000

export const useActivityRuntimeStore = defineStore('activityRuntime', () => {
  const activities = useActivitiesStore()
  const workbench = useWorkbenchStore()
  const ready = ref(false)
  const error = ref('')
  const lastLaunchMetrics = ref(null)
  const resumingActivityIds = ref(new Set())
  const blockingInputActivityIds = ref(new Set())
  let unlisten = null
  let nextArchiveMutation = 0
  const archiveMutations = new Map()
  const resumePromises = new Map()
  const movingActivityIds = ref(new Set())
  const restorationState = new Map()

  function upsertBackendRecord(record) {
    const canonical = canonicalBackendRecord(record)
    const restoration = restorationState.get(canonical?.id)
    return activities.upsert(restoration
      ? {
          ...canonical,
          unread: false,
          updatedAt: restoration.updatedAt,
        }
      : canonical)
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
        cwd: resolved.cwd,
      },
    )
    const record = {
      id,
      kind,
      title: options.title || resolved.title,
      titleSource: kind === 'agent' && !options.title ? 'launcher' : 'manual',
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
  function resumePreset(preset, activity, options = {}) {
    if (movingActivityIds.value.has(activity.id) && !options.prepared) {
      return Promise.reject(new Error('This session is being moved.'))
    }
    const existing = resumePromises.get(activity.id)
    if (existing) return existing
    beginSessionRestoration(activity, { automatic: Boolean(options.automatic) })
    setResumePending(activity.id, true)
    clearActivityError(activity.id)
    let resumed = false
    const promise = resumePresetExact(preset, activity, options)
      .then(async (record) => {
        resumed = true
        if (options.automatic) {
          await restorationState.get(activity.id)?.ready
        }
        return record
      })
      .catch((cause) => {
        endSessionRestoration(activity.id)
        if (options.automatic) markAutomaticResumeFailure(activity.id, cause)
        else markActivityError(activity.id, `Resume failed: ${message(cause)}`)
        throw cause
      })
      .finally(() => {
        resumePromises.delete(activity.id)
        // Restoration remains pending until the new run produces terminal
        // output. A successful process spawn alone is not usable UI.
        if (!resumed) setResumePending(activity.id, false)
      })
    resumePromises.set(activity.id, promise)
    return promise
  }

  async function prepareResume(preset, activity) {
    const startedAt = monotonicNow()
    const workspaceScope = normalizedWorkspaceScope(
      activity.source?.workspaceScope,
      presetWorkspaceScope(preset),
    )
    // Recorded workspace ownership survives changes to the launcher preset.
    const effectivePreset = workspaceScope === 'workspace'
      ? { ...preset, cwd: { mode: 'workspace' } }
      : preset
    const resolved = await resolveLauncher(effectivePreset, activity.workspacePath)
    const resolvedAt = monotonicNow()
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
      cwd: resolved.cwd,
    })
    // A continuation keeps the launch policy of the session it belongs to.
    // Resolving the launcher again supplies the current executable and identity,
    // but must not silently replace the recorded model, permission, or tool flags.
    const recordedArgs = [...(Array.isArray(activity.launch?.args)
      ? activity.launch.args
      : resolved.args)]
    // The native launcher owns the status title. Refresh this UI integration
    // for old sessions while preserving their model, permission, and tool flags.
    const statusTitle = resumeStrategy === 'codex'
      ? resolved.args.find(arg => arg.startsWith('tui.terminal_title='))
      : null
    if (statusTitle && !recordedArgs.includes(statusTitle)) recordedArgs.push('-c', statusTitle)
    const recordedMcpUrl = activity.launch?.env?.MIMIR_MCP_URL || baseMcpUrl
    const record = {
      ...activity,
      status: 'ready',
      updatedAt: restorationState.get(activity.id)?.updatedAt || activity.updatedAt,
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
    return { record, cliSessionId, resolved, startedAt, resolvedAt }
  }

  async function resumePresetExact(preset, activity, options) {
    const { record, cliSessionId, resolved, startedAt, resolvedAt } = options.prepared
      || await prepareResume(preset, activity)
    const snapshot = await respawnActivity(record, {}, cliSessionId)
    const spawnedAt = monotonicNow()
    upsertBackendRecord(snapshot.record)
    if (options.open !== false) workbench.openActivity(activity.id)
    recordLaunchMetrics({
      presetId: resolved.presetId,
      kind: activity.kind,
      resolveMs: resolvedAt - startedAt,
      spawnMs: spawnedAt - resolvedAt,
      totalMs: spawnedAt - startedAt,
    })
    return snapshot.record
  }

  async function moveToWorkspace(preset, id, workspacePath, { beforeStop } = {}) {
    if (movingActivityIds.value.has(id) || resumingActivityIds.value.has(id) || resumePromises.has(id)) {
      throw new Error('This session is already being moved or resumed.')
    }
    movingActivityIds.value = new Set([...movingActivityIds.value, id])
    try {
      const original = await prepareActivityWorkspaceMove(id, workspacePath)
      if (!canMoveActivityWorkspace(original)) throw new Error('This session cannot be moved.')
      const prepared = await prepareResume(preset, {
        ...original,
        workspacePath,
        source: { ...original.source, workspaceScope: 'workspace' },
      })
      prepared.record.launch.args = codexWorkspaceArguments(prepared.record.launch.args, workspacePath)
      // Preparation and workspace setup can fail or be cancelled without
      // stopping the original process or changing its saved workspace.
      if (beforeStop && await beforeStop() === false) return null
      let snapshot = await activitySnapshot(id, Number.MAX_SAFE_INTEGER)
      if (snapshot.record.session?.runId !== original.session?.runId || snapshot.record.closeRequestedAt) {
        throw new Error('The session changed during preparation. Try again.')
      }
      await stopActivity(id)
      const deadline = Date.now() + 10_000
      do {
        snapshot = await activitySnapshot(id, Number.MAX_SAFE_INTEGER)
        if (snapshot.record.session?.runId !== original.session?.runId
          || snapshot.record.session?.cliSessionId !== original.session?.cliSessionId
          || snapshot.record.closeRequestedAt || snapshot.record.archivedAt) {
          throw new Error('The session changed during the move. Its workspace has not changed.')
        }
        if (!snapshot.live && (snapshot.record.session?.exit || snapshot.record.status === 'interrupted')) break
        if (Date.now() >= deadline) throw new Error('The session did not stop. Its workspace has not changed.')
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (true)
      upsertBackendRecord(snapshot.record)
      // Use the stopped source record for restoration state. The destination
      // record enters the store only after native respawn succeeds.
      return await resumePreset(preset, snapshot.record, { prepared, open: false })
    } finally {
      const next = new Set(movingActivityIds.value)
      next.delete(id)
      movingActivityIds.value = next
    }
  }

  function markAutomaticResumeFailure(id, cause) {
    return markActivityError(id, `Automatic resume failed: ${message(cause)}`)
  }

  function markActivityError(id, cause) {
    const activity = activities.byId(id)
    if (!activity) return null
    if (restorationState.has(id)) endSessionRestoration(id)
    return activities.upsert({
      ...activity,
      error: message(cause),
      updatedAt: new Date().toISOString(),
    })
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
      titleSource: 'manual',
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
        titleSource: 'manual',
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
    endSessionRestoration(id)
    const activity = activities.byId(id)
    if (activity && activity.host?.type !== 'pty') {
      activities.remove(id)
      setBlockingInput(id, false)
      return
    }
    await clearActivity(id)
    activities.remove(id)
    setBlockingInput(id, false)
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'upsert' && event.record) {
      if (event.record.status === 'error') {
        endSessionRestoration(event.record.id)
        setResumePending(event.record.id, false)
      }
      upsertBackendRecord(event.record)
      if (event.record.status !== 'needs-input') setBlockingInput(event.record.id, false)
      return
    }
    if (event.type === 'status' && activities.byId(event.activityId)) {
      const restoration = restorationState.get(event.activityId)
      activities.reconcileStatus(
        event.activityId,
        event.status,
        restoration?.updatedAt,
      )
      setBlockingInput(
        event.activityId,
        !restoration
          && event.status === 'needs-input'
          && event.needsInputIsBlocking === true,
      )
      return
    }
    if (event.type === 'output') {
      if (
        outputHasBytes(event.bytes)
        && restorationState.has(event.activityId)
      ) {
        markSessionRestorationReady(event.activityId)
        return
      }
      recordInactiveAgentOutput(event)
      return
    }
    if (event.type === 'exit' && event.record) {
      // A stop snapshot can reach the caller before the old exit event.
      // Once a new run is installed, that event must not restore the old cwd.
      const currentRun = activities.byId(event.record.id)?.session?.runId
      if (currentRun && event.record.session?.runId && currentRun !== event.record.session.runId) return
      endSessionRestoration(event.activityId || event.record.id)
      setResumePending(event.activityId || event.record.id, false)
      upsertBackendRecord(event.record)
      setBlockingInput(event.activityId || event.record.id, false)
    }
  }

  function recordInactiveAgentOutput(event) {
    if (!outputHasBytes(event.bytes)) return
    const activity = activities.byId(event.activityId)
    if (!activity || activity.kind !== 'agent') return
    if (workbench.activeActivityId === activity.id) return

    if (activity.unread) return
    const now = Date.now()
    activities.upsert({
      ...activity,
      unread: true,
      updatedAt: new Date(now).toISOString(),
    })
  }

  async function dispose() {
    if (unlisten) unlisten()
    unlisten = null
    archiveMutations.clear()
    for (const id of restorationState.keys()) endSessionRestoration(id)
    resumingActivityIds.value = new Set()
    blockingInputActivityIds.value = new Set()
    ready.value = false
  }

  return {
    ready,
    error,
    lastLaunchMetrics,
    resumingActivityIds,
    blockingInputActivityIds,
    initialize,
    launchPreset,
    resumePreset,
    moveToWorkspace,
    movingActivityIds,
    markActivityInteraction,
    markActivityError,
    markAutomaticResumeFailure,
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

  function setResumePending(id, pending) {
    const next = new Set(resumingActivityIds.value)
    if (pending) next.add(id)
    else next.delete(id)
    resumingActivityIds.value = next
  }

  function setBlockingInput(id, blocking) {
    if (!id || blockingInputActivityIds.value.has(id) === blocking) return
    const next = new Set(blockingInputActivityIds.value)
    if (blocking) next.add(id)
    else next.delete(id)
    blockingInputActivityIds.value = next
  }

  function beginSessionRestoration(activity, { automatic = false } = {}) {
    if (!activity?.id || restorationState.has(activity.id)) return
    let resolveReady
    const ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    const restoration = {
      updatedAt: activity.updatedAt,
      ready,
      resolveReady,
      readyResolved: false,
      timeoutId: 0,
    }
    restoration.timeoutId = setTimeout(() => {
      if (restorationState.get(activity.id) !== restoration) return
      endSessionRestoration(activity.id)
      const failure = 'The session started but did not produce terminal output.'
      if (automatic) markAutomaticResumeFailure(activity.id, failure)
      else markActivityError(activity.id, `Resume failed: ${failure}`)
    }, AUTOMATIC_RESTORE_READY_TIMEOUT_MS)
    restorationState.set(activity.id, restoration)
    activities.upsert({
      ...activity,
      unread: false,
    })
  }

  function endSessionRestoration(id) {
    markSessionRestorationReady(id)
    restorationState.delete(id)
  }

  function markSessionRestorationReady(id) {
    const restoration = restorationState.get(id)
    if (restoration && !restoration.readyResolved) {
      restoration.readyResolved = true
      clearTimeout(restoration.timeoutId)
      restoration.resolveReady()
    }
    setResumePending(id, false)
  }

  function markActivityInteraction(id) {
    const restoration = restorationState.get(id)
    endSessionRestoration(id)
    const activity = restoration ? activities.byId(id) : null
    if (activity) {
      activities.upsert({
        ...activity,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  function clearActivityError(id) {
    const activity = activities.byId(id)
    if (!activity?.error) return
    activities.upsert({ ...activity, error: null })
  }
})

function canonicalBackendRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record
  // Rust omits Option::None fields. Activity records are otherwise merged with
  // existing renderer state, so an omitted archivedAt must be made explicit or
  // a restored Activity retains its previous archive timestamp forever.
  return {
    ...record,
    archivedAt: record.archivedAt ?? null,
    closeRequestedAt: record.closeRequestedAt ?? null,
    error: record.error ?? null,
  }
}

function outputHasBytes(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? value.length > 0
    : false
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
    '--no-daemon',
    '--approve-for-me',
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

// Remove only working-directory overrides. Other permission/model/tool flags
// remain part of the recorded launch policy. A final --cd wins over config.
export function codexWorkspaceArguments(args, workspacePath) {
  const result = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--cd' || arg === '-C') { index++; continue }
    if (arg.startsWith('--cd=') || (arg.startsWith('-C') && arg.length > 2)) continue
    result.push(arg)
    // Values such as model names and config strings are not CLI switches.
    if (['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
      '-a', '--ask-for-approval', '--add-dir', '--enable', '--disable',
      '--remote', '--remote-auth-token-env', '--local-provider'].includes(arg)
      && index + 1 < args.length) result.push(args[++index])
  }
  return [...result, '--cd', workspacePath]
}
