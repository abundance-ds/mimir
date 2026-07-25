import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createMimTools } from './ai/tools/index.js'

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

export function createToolRuntime(options = {}) {
  const pending = new Map()
  let unlistenRequest = null
  let unlistenCancel = null
  let started = false

  async function start() {
    if (started) return
    // The listeners must exist before the server begins accepting requests.
    unlistenRequest = await listen('mim://tool-relay-request', ({ payload }) => {
      void handle(payload)
    })
    unlistenCancel = await listen('mim://tool-relay-cancel', ({ payload }) => {
      pending.get(payload?.id)?.abort()
      pending.delete(payload?.id)
    })
    try {
      await invoke('tool_server_start', {})
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
    for (const controller of pending.values()) controller.abort()
    pending.clear()
    unlistenRequest?.()
    unlistenCancel?.()
    unlistenRequest = null
    unlistenCancel = null
    if (started) await invoke('tool_server_stop', {}).catch(() => {})
    started = false
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

  if (tool.startsWith('editor.')) {
    return executeEditorTool(resolveEditor(options), tool, input)
  }

  switch (tool) {
    case 'activities.list':
      return options.listActivities
        ? options.listActivities()
        : invoke('activity_list')
    case 'activities.spawn':
      return options.spawnActivity
        ? options.spawnActivity(input)
        : invoke('activity_spawn', {
            record: input.record,
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
          })
    case 'apps.list':
      return options.listApps ? options.listApps() : invoke('app_catalog')
    case 'apps.launch':
      if (!options.launchApp) throw unavailableError('No app host is attached.')
      return options.launchApp(input.app_id, input.mode)
    case 'routines.list':
      return options.listRoutines
        ? options.listRoutines()
        : invoke('routine_catalog')
    case 'routines.run':
      return options.runRoutine
        ? options.runRoutine(input.routine_id)
        : invoke('routine_run_now', { routineId: input.routine_id })
    case 'settings.get':
      return readSettings(options.settings, input.keys)
    case 'settings.update':
      return updateSettings(options.settings, input.values)
    default:
      return executeWorkspaceTool(request, options)
  }
}

async function executeWorkspaceTool(request, options) {
  const alias = CORE_TOOL_ALIASES[request.tool]
  if (!alias) throw notFoundError(`Tool '${request.tool}' has no renderer handler.`)

  const editor = resolveEditor(options, false)
  const workspacePath = options.getWorkspacePath?.()
    || request.context?.cwd
    || null
  const tools = createMimTools({
    sessionId: request.context?.activityId || 'mcp',
    projectId: 'workspace',
    projectPath: workspacePath,
    disabledTools: [],
    getDocument: () => editor?.mimActive?.({ includeContent: true }) || null,
    onProposal: options.onProposal || (() => {}),
    signal: options.signal,
  })
  const implementation = tools[alias]
  if (!implementation) throw notFoundError(`Tool '${request.tool}' is not installed.`)
  return implementation.execute(request.input || {})
}

function resolveEditor(options, required = true) {
  const editor = typeof options.getEditor === 'function'
    ? options.getEditor()
    : options.editor
  if (!editor && required) throw unavailableError('No editor is attached.')
  return editor
}

async function executeEditorTool(editor, tool, input) {
  switch (tool) {
    case 'editor.open':
      return editor.mimOpen(input.path)
    case 'editor.active':
      return editor.mimActive({ includeContent: Boolean(input.includeContent) })
    case 'editor.tabs':
      return editor.mimTabs()
    case 'editor.content':
      return editor.mimActive({ includeContent: true })
    case 'editor.selection':
      return editor.mimSelection()
    case 'editor.comments':
      return editor.mimComments()
    case 'editor.replace_selection':
      return editor.mimReplaceSelection(input.text || '')
    case 'editor.set_content':
      return editor.mimSetContent(input.content || '')
    case 'editor.reveal':
      return editor.mimReveal(input)
    case 'editor.save':
      return editor.mimSave()
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
    settings.set(key, value)
    updated[key] = value
  }
  await settings.save?.()
  return { updated }
}

function isPublicSetting(key) {
  return /^(editor|ai|comment|mimWorkspace|workbench)/.test(key)
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
