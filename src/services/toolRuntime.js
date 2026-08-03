import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { spawnActivity } from './activities.js'
import { createMimirTools } from './ai/tools/index.js'

const CORE_TOOL_ALIASES = Object.freeze({
  'files.read': 'read',
  'files.list': 'list',
  'files.search': 'search',
  'files.edit': 'edit',
  'files.create': 'create',
  'comments.add': 'comment_add',
  'comments.reply': 'comment_reply',
  'web.search': 'search_web',
  'shell.run': 'shell',
})

let nextRuntimeClientId = 1

export function createToolRuntime(options = {}) {
  const clientId = `renderer-${Date.now()}-${nextRuntimeClientId++}`
  const pending = new Map()
  let unlistenRequest = null
  let unlistenCancel = null
  let started = false

  async function start() {
    if (started) return
    // The listeners must exist before the server begins accepting requests.
    unlistenRequest = await listen('mimir://tool-relay-request', ({ payload }) => {
      void handle(payload)
    })
    unlistenCancel = await listen('mimir://tool-relay-cancel', ({ payload }) => {
      pending.get(payload?.id)?.abort()
      pending.delete(payload?.id)
    })
    try {
      await invoke('tool_server_start', { clientId })
      started = true
    } catch (error) {
      unlistenRequest?.()
      unlistenCancel?.()
      unlistenRequest = null
      unlistenCancel = null
      throw error
    }
  }

  async function stop() {
    // Keep relay listeners alive until the native accept loop is closed. A
    // request already in flight can still complete; anything pending after the
    // stop signal is then aborted before listeners are removed.
    if (started) await invoke('tool_server_stop', { clientId }).catch(() => {})
    started = false
    for (const controller of pending.values()) controller.abort()
    pending.clear()
    unlistenRequest?.()
    unlistenCancel?.()
    unlistenRequest = null
    unlistenCancel = null
  }

  async function handle(request) {
    if (!request?.id || !request?.tool) return
    const controller = new AbortController()
    pending.set(request.id, controller)
    try {
      const value = await executeToolRequest(request, {
        ...options,
        signal: controller.signal,
      })
      if (!controller.signal.aborted) await respondSuccess(request.id, value)
    } catch (error) {
      if (!controller.signal.aborted) await respondError(request.id, error)
    } finally {
      pending.delete(request.id)
    }
  }

  return {
    start,
    stop,
    handle,
    get started() {
      return started
    },
    get pendingCount() {
      return pending.size
    },
  }
}

export async function executeToolRequest(request, options = {}) {
  const { tool, input = {}, context = {} } = request
  if (options.signal?.aborted) throw cancelledError()

  if (tool === 'editor.propose') {
    return executeEditorProposal(request, options)
  }
  if (tool.startsWith('editor.')) {
    return executeEditorTool(resolveEditor(options), tool, input, options)
  }
  if (['comments.resolve', 'comments.reopen', 'comments.delete'].includes(tool)) {
    return executeEditorCommentTool(resolveEditor(options), tool, input)
  }

  switch (tool) {
    case 'activities.auto-title': {
      const activityId = String(context.metadata?.activityId || '').trim()
      if (!activityId) {
        throw invalidInputError('mimir_title is only available inside a scoped Activity.')
      }
      return options.autoTitleActivity
        ? options.autoTitleActivity(activityId, input.title)
        : invoke('activity_auto_title', {
            activityId,
            title: input.title,
          })
    }
    case 'activities.list':
      return options.listActivities
        ? options.listActivities()
        : invoke('activity_list')
    case 'activities.spawn':
      return options.spawnActivity
        ? options.spawnActivity(input)
        : spawnActivity(input.record, { cols: input.cols, rows: input.rows })
    case 'activities.stop':
      if (options.stopActivity) return options.stopActivity(input.activity_id)
      await invoke('activity_stop', { activityId: input.activity_id })
      return { activity_id: input.activity_id, status: 'stopping' }
    case 'activities.rename':
      return options.renameActivity
        ? options.renameActivity(input.activity_id, input.title)
        : invoke('activity_rename', {
            activityId: input.activity_id,
            title: input.title,
          })
    case 'activities.archive':
      return options.archiveActivity
        ? options.archiveActivity(input.activity_id, input.archived)
        : invoke('activity_set_archived', {
            activityId: input.activity_id,
            archived: input.archived,
          })
    case 'activities.clear':
      if (options.clearActivity) return options.clearActivity(input.activity_id)
      await invoke('activity_clear', { activityId: input.activity_id })
      return { activity_id: input.activity_id, status: 'cleared' }
    case 'apps.list':
      return options.listApps ? options.listApps() : invoke('app_catalog')
    case 'apps.launch':
      if (!options.launchApp) throw unavailableError('No app host is attached.')
      return options.launchApp(input.app_id, input.mode)
    case 'apps.reload':
      return options.reloadApps
        ? options.reloadApps()
        : invoke('app_reload')
    case 'apps.create':
      return options.createApp
        ? options.createApp(input)
        : invoke('app_create', {
            id: input.id,
            title: input.title,
            description: input.description || null,
          })
    case 'apps.duplicate':
      return options.duplicateApp
        ? options.duplicateApp(input.app_id, {
            id: input.new_id,
            title: input.title || '',
          })
        : invoke('app_duplicate', {
            appId: input.app_id,
            newId: input.new_id,
            title: input.title || null,
          })
    case 'apps.update':
      return options.updateApp
        ? options.updateApp(input.app_id, input.title)
        : invoke('app_update_title', {
            appId: input.app_id,
            title: input.title,
          })
    case 'apps.trash':
      return options.trashApp
        ? options.trashApp(input.app_id)
        : invoke('app_trash', { appId: input.app_id })
    case 'routines.list':
      return options.listRoutines
        ? options.listRoutines()
        : invoke('routine_catalog')
    case 'routines.run':
      return options.runRoutine
        ? options.runRoutine(input.routine_id)
        : invoke('routine_run_now', { routineId: input.routine_id })
    case 'routines.create':
      return invokeNativeTool('routine_create', {
        definition: normalizeRoutineDefinition(input.definition),
      })
    case 'routines.update':
      requireMatchingRoutineId(input.routine_id, input.definition?.id)
      return invokeNativeTool('routine_update', {
        routineId: input.routine_id,
        expectedRevision: input.expected_revision,
        definition: normalizeRoutineDefinition({
          ...input.definition,
          id: input.routine_id,
        }),
      })
    case 'routines.duplicate':
      return invokeNativeTool('routine_duplicate', {
        routineId: input.routine_id,
        expectedRevision: input.expected_revision,
        newId: input.new_id,
        title: input.title || null,
      })
    case 'routines.trash':
      return invokeNativeTool('routine_trash', {
        routineId: input.routine_id,
        expectedRevision: input.expected_revision,
      })
    case 'files.browse':
      return {
        directory: input.directory || '',
        entries: await invokeNativeTool('workspace_file_list_directory', {
          directory: input.directory || '',
        }),
      }
    case 'files.create_folder':
      return {
        entry: await invokeNativeTool('workspace_file_create', {
          relativePath: input.path,
          directory: true,
        }),
      }
    // Rename and trash reconcile open Editor state the same way the Files
    // panel does: wait out pending writes so a save cannot resurrect the old
    // path, mutate, then repoint or release the affected buffers.
    case 'files.rename': {
      const source = absoluteWorkspacePath(options, input.path)
      await options.awaitWorkspaceWrites?.([source])
      const entry = await invokeNativeTool('workspace_file_rename', {
        path: input.path,
        newName: input.new_name,
      })
      options.moveWorkspacePath?.(source, entry.path)
      return { entry }
    }
    case 'files.duplicate':
      return {
        entry: await invokeNativeTool('workspace_file_duplicate', {
          path: input.path,
        }),
      }
    case 'files.trash': {
      const targets = (input.paths || []).map(path => absoluteWorkspacePath(options, path))
      await options.awaitWorkspaceWrites?.(targets)
      const trashedPaths = await invokeNativeTool('workspace_file_trash', {
        paths: input.paths,
      })
      options.reconcileWorkspaceTrash?.(targets)
      return { trashedPaths }
    }
    case 'settings.get':
      return readSettings(options.settings, input.keys)
    case 'settings.update':
      return updateSettings(options.settings, input.values)
    default:
      return executeWorkspaceTool(request, options)
  }
}

function requireMatchingRoutineId(routineId, definitionId) {
  if (routineId !== definitionId) {
    throw invalidInputError(
      'definition.id must match routine_id. Duplicate the routine to create a new stable id.',
    )
  }
}

function normalizeRoutineDefinition(value = {}) {
  return {
    id: String(value.id || '').trim(),
    title: String(value.title || '').trim(),
    enabled: value.enabled !== false,
    schedule: String(value.schedule || '').trim() || null,
    timezone: String(value.timezone || '').trim() || 'local',
    preset: String(value.preset || '').trim(),
    prompt: String(value.prompt || ''),
    overlap: String(value.overlap || 'skip'),
    missed: String(value.missed || 'run-once'),
    workspace: value.workspace == null || !String(value.workspace).trim()
      ? null
      : String(value.workspace).trim(),
    interactive: value.interactive === true,
  }
}

// Editor reconciliation matches tabs by absolute path, while tool input may
// name entries workspace-relative (both are valid native input).
function absoluteWorkspacePath(options, path) {
  const value = String(path || '')
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return value
  const root = String(options.getWorkspacePath?.() || '').replace(/[\\/]+$/, '')
  return root ? `${root}/${value}` : value
}

async function invokeNativeTool(command, args) {
  try {
    return await invoke(command, args)
  } catch (error) {
    if (error?.code && error?.message) throw error
    const message = error?.message || String(error || `${command} failed.`)
    if (/inside the open workspace|workspace root|folder separators|changed on disk|missing its source revision|already exists|invalid routine|cannot be changed in place/i.test(message)) {
      throw invalidInputError(message)
    }
    if (/was not found|does not exist|cannot be accessed/i.test(message)) {
      throw notFoundError(message)
    }
    throw toolError('handler', message)
  }
}

function executeEditorCommentTool(editor, tool, input) {
  const action = tool.slice('comments.'.length)
  if (!input?.comment_id) throw invalidInputError('comment_id is required.')
  const result = editor.mimirCommentAction?.(action, input.comment_id)
  if (!result) throw unavailableError('The attached editor does not support comment actions.')
  if (result.ok === false) throw toolError('handler', result.error || `Could not ${action} comment.`)
  return {
    comment_id: input.comment_id,
    status: action === 'delete' ? 'deleted' : action === 'resolve' ? 'resolved' : 'active',
  }
}

async function executeWorkspaceTool(request, options) {
  const alias = CORE_TOOL_ALIASES[request.tool]
  if (!alias) throw notFoundError(`Tool '${request.tool}' has no renderer handler.`)

  const editor = resolveEditor(options, false)
  const workspacePath = options.getWorkspacePath?.()
    || request.context?.cwd
    || null
  const tools = createMimirTools({
    sessionId: request.context?.activityId || 'mcp',
    projectId: 'workspace',
    projectPath: workspacePath,
    disabledTools: [],
    getDocument: () => editor?.mimirActive?.({ includeContent: true }) || null,
    setDocument: content => editor?.mimirSetContent?.(content),
    onProposal: options.onProposal || createEditorProposalBridge(editor, request),
    signal: options.signal,
  })
  const implementation = tools[alias]
  if (!implementation) throw notFoundError(`Tool '${request.tool}' is not installed.`)
  return implementation.execute(request.input || {})
}

async function executeEditorProposal(request, options) {
  const editor = resolveEditor(options)
  if (request.input?.path) await editor.mimirOpen(request.input.path)
  return executeWorkspaceTool({
    ...request,
    tool: 'files.edit',
    input: {
      target: '@editor',
      old_text: request.input?.old_text,
      new_text: request.input?.new_text,
      rationale: request.input?.rationale,
    },
  }, options)
}

function createEditorProposalBridge(editor, request) {
  return async (proposal) => {
    if (proposal?.status !== 'pending') return proposal

    const active = editor?.mimirActive?.() || null
    const path = proposal.path || active?.path || null
    const enriched = {
      ...proposal,
      path,
      absolutePath: path,
      sessionId: request.context?.activityId || 'mcp',
      threadId: request.context?.activityId || 'mcp',
    }

    // Open the review immediately in the stable editor surface. Registering it
    // natively afterwards keeps the same proposal visible to every caller and
    // lets accept/reject complete the shared lifecycle.
    await editor?.mimirReviewProposal?.(enriched)
    await invoke('proposal_create', { proposal: enriched })
    return enriched
  }
}

function resolveEditor(options, required = true) {
  const editor = typeof options.getEditor === 'function'
    ? options.getEditor()
    : options.editor
  if (!editor && required) throw unavailableError('No editor is attached.')
  return editor
}

async function executeEditorTool(editor, tool, input, options = {}) {
  switch (tool) {
    case 'editor.open':
      return editor.mimirOpen(input.path)
    case 'editor.state':
      return {
        ...editor.mimirState({ includeContent: Boolean(input.include_content) }),
        today: options.getToday ? await options.getToday() : null,
      }
    case 'editor.active':
      return editor.mimirActive({ includeContent: Boolean(input.includeContent) })
    case 'editor.tabs':
      return editor.mimirTabs()
    case 'editor.content':
      return editor.mimirActive({ includeContent: true })
    case 'editor.selection':
      return editor.mimirSelection()
    case 'editor.comments':
      return editor.mimirComments()
    case 'editor.replace_selection':
      return editor.mimirReplaceSelection(input.text || '')
    case 'editor.set_content':
      return editor.mimirSetContent(input.content || '')
    case 'editor.reveal':
      return await editor.mimirReveal(input)
    case 'editor.save':
      return editor.mimirSave()
    default:
      throw notFoundError(`Unknown editor tool '${tool}'.`)
  }
}

function readSettings(settings, keys) {
  if (!settings) throw unavailableError('Settings are not attached.')
  const requested = Array.isArray(keys) && keys.length
    ? keys
    : Object.keys(settings.$state || {})
  return Object.fromEntries(
    requested
      .filter(key => isPublicSetting(key) && key in settings)
      .map(key => [key, settings[key]]),
  )
}

async function updateSettings(settings, values) {
  if (!settings) throw unavailableError('Settings are not attached.')
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw invalidInputError('values must be an object.')
  }
  const updated = {}
  for (const [key, value] of Object.entries(values)) {
    if (!isPublicSetting(key) || !(key in settings)) {
      throw invalidInputError(`Setting '${key}' is not editable through MCP.`)
    }
    if (!hasCompatibleSettingShape(settings[key], value)) {
      throw invalidInputError(`Setting '${key}' has an incompatible value type.`)
    }
    settings.set(key, value)
    updated[key] = value
  }
  await settings.save?.()
  return { updated }
}

function hasCompatibleSettingShape(current, next) {
  if (typeof current === 'number') return typeof next === 'number' && Number.isFinite(next)
  if (Array.isArray(current)) return Array.isArray(next)
  if (current && typeof current === 'object') {
    return Boolean(next) && typeof next === 'object' && !Array.isArray(next)
  }
  return typeof next === typeof current
}

function isPublicSetting(key) {
  return /^(editor|ai|comment|mimirWorkspace|workbench)/.test(key)
}

async function respondSuccess(id, value) {
  return invoke('tool_relay_response', {
    response: {
      id,
      result: { value: value ?? null, metadata: {} },
      error: null,
    },
  })
}

async function respondError(id, error) {
  return invoke('tool_relay_response', {
    response: {
      id,
      result: null,
      error: normalizeToolError(error),
    },
  })
}

export function normalizeToolError(error) {
  if (error?.code && error?.message) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    }
  }
  return {
    code: 'handler',
    message: error?.message || String(error),
  }
}

function toolError(code, message, data) {
  return Object.assign(new Error(message), { code, data })
}

function invalidInputError(message) {
  return toolError('invalid_input', message)
}

function unavailableError(message) {
  return toolError('unavailable', message)
}

function notFoundError(message) {
  return toolError('not_found', message)
}

function cancelledError() {
  return toolError('cancelled', 'Tool call was cancelled.')
}
