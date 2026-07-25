import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const APP_TOOL_REQUEST_EVENT = 'mim://tool-relay-request'
export const APP_TOOL_CANCEL_EVENT = 'mim://tool-relay-cancel'

export async function loadAppsCatalog() {
  return normalizeCatalog(await invoke('app_catalog'))
}

export function resolveAppLaunch(appId, workspacePath = '') {
  return invoke('app_resolve', {
    appId,
    workspacePath: workspacePath || null,
  })
}

export function openAppWindow(appId, workspacePath = '') {
  return invoke('app_open_window', {
    appId,
    workspacePath: workspacePath || null,
  })
}

export function callAppAction(appId, tool, input = {}, workspacePath = '') {
  return invoke('tool_registry_call', {
    request: {
      tool,
      input,
      caller: { kind: 'app', id: appId },
      requestId: `app:${appId}:${crypto.randomUUID()}`,
      cwd: workspacePath || null,
      metadata: {},
    },
  })
}

export function loadAppData(appId, key) {
  return invoke('app_data_load', { appId, key })
}

export function saveAppData(appId, key, value) {
  return invoke('app_data_save', { appId, key, value })
}

export function deleteAppData(appId, key) {
  return invoke('app_data_delete', { appId, key })
}

export function invokeAppCommand(appId, command, args = {}) {
  const name = String(command || '')
  const input = isPlainObject(args) ? args : {}
  if (!name) return Promise.reject(new Error('App command is required.'))
  if (name === 'tool_registry_call') {
    const request = isPlainObject(input.request) ? input.request : {}
    return invoke(name, {
      request: {
        tool: String(request.tool || ''),
        input: isPlainObject(request.input) ? request.input : {},
        caller: { kind: 'app', id: appId },
        requestId: request.requestId == null ? null : String(request.requestId),
        cwd: request.cwd == null ? null : String(request.cwd),
        metadata: isPlainObject(request.metadata) ? request.metadata : {},
      },
    })
  }
  if (name === 'tool_registry_list') return invoke(name)
  if (name.startsWith('tool_')) {
    return Promise.reject(new Error('App tools use the host relay, not direct provider commands.'))
  }
  if (name === 'app_data_load' || name === 'app_data_delete') {
    return invoke(name, { appId, key: input.key })
  }
  if (name === 'app_data_save') {
    return invoke(name, { appId, key: input.key, value: input.value })
  }
  if (name === 'app_open_window') {
    return invoke(name, {
      appId,
      workspacePath: input.workspacePath || input.workspace_path || null,
    })
  }
  if (name === 'app_http_request') {
    const { appId: _ignored, projectId: _obsolete, ...request } = input
    return invoke(name, request)
  }
  return invoke(name, input)
}

export function reconcileAppTools({
  appId,
  instanceId,
  tools,
  timeoutMs = 30_000,
}) {
  return invoke('tool_app_provider_reconcile', {
    appId,
    instanceId,
    definitions: dynamicToolDefinitions(appId, tools),
    timeoutMs,
  })
}

export function unregisterAppTools(appId, instanceId) {
  return invoke('tool_app_provider_unregister', { appId, instanceId })
}

export function respondToAppTool(id, result) {
  return invoke('tool_relay_response', {
    response: {
      id,
      result: {
        value: result?.value ?? null,
        displayText: result?.displayText ?? null,
        metadata: result?.metadata || {},
      },
      error: null,
    },
  })
}

export function rejectAppTool(id, message, code = 'handler', data = null) {
  return invoke('tool_relay_response', {
    response: {
      id,
      result: null,
      error: { code, message: String(message || 'App tool failed.'), data },
    },
  })
}

export async function listenForAppTools({
  appId,
  instanceId,
  onCall,
  onCancel = () => {},
}) {
  const unlistenCall = await listen(APP_TOOL_REQUEST_EVENT, (event) => {
    const request = event?.payload
    if (!matchesAppTarget(request?.target, appId, instanceId)) return
    onCall(request)
  })
  try {
    const unlistenCancel = await listen(APP_TOOL_CANCEL_EVENT, (event) => {
      const cancellation = event?.payload
      if (!matchesAppTarget(cancellation?.target, appId, instanceId)) return
      onCancel(cancellation)
    })
    return () => {
      unlistenCall()
      unlistenCancel()
    }
  } catch (error) {
    unlistenCall()
    throw error
  }
}

export function dynamicToolDefinitions(appId, tools = []) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    canonicalName: tool.name?.includes('.')
      ? String(tool.name)
      : `app.${appId}.${tool.name}`,
    mcpAlias: tool.mcpAlias || tool.mcp_alias || `${appId}_${tool.name}`,
    description: String(tool.description || ''),
    inputSchema: isPlainObject(tool.inputSchema)
      ? tool.inputSchema
      : isPlainObject(tool.input_schema)
        ? tool.input_schema
        : { type: 'object', properties: {} },
  }))
}

export function embeddedAppUrl(app, launch) {
  const url = String(launch?.url || '')
  if (!url) return ''
  if (/^(https?:|app:|mim:)/i.test(url)) return url
  if (url.startsWith('file://')) {
    const entry = String(app?.entry || 'index.html')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return `app://localhost/${encodeURIComponent(app?.id || launch?.appId || '')}/${entry}`
  }
  return url
}

export function createAppActivity(app, launch, workspacePath = '') {
  const now = new Date().toISOString()
  const appId = String(app?.id || launch?.appId || '').trim()
  if (!appId) throw new Error('App id is required to create an Activity.')
  return {
    id: `app:${appId}`,
    kind: 'app',
    title: String(app?.title || appId),
    workspacePath: workspacePath || '',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    retention: 'durable',
    source: {
      type: 'app',
      appId,
      app: serializableApp(app),
    },
    host: {
      type: 'app',
      mode: launch?.mode || app?.mode || 'embedded',
    },
    launch: {
      plan: serializableClone(launch || {}),
    },
  }
}

function matchesAppTarget(target, appId, instanceId) {
  if (!target || target.kind !== 'app') return false
  return (target.appId ?? target.app_id) === appId
    && (target.instanceId ?? target.instance_id) === instanceId
}

function normalizeCatalog(value) {
  const catalog = isPlainObject(value) ? value : {}
  return {
    directory: String(catalog.directory || ''),
    apps: (Array.isArray(catalog.apps) ? catalog.apps : [])
      .filter(isPlainObject)
      .map((app) => serializableApp(app))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
    diagnostics: (Array.isArray(catalog.diagnostics) ? catalog.diagnostics : [])
      .filter(isPlainObject)
      .map((diagnostic) => ({
        path: String(diagnostic.path || ''),
        field: diagnostic.field == null ? null : String(diagnostic.field),
        message: String(diagnostic.message || 'Invalid app definition.'),
      })),
  }
}

function serializableApp(app) {
  return {
    id: String(app?.id || ''),
    title: String(app?.title || app?.id || 'Untitled app'),
    description: String(app?.description || ''),
    mode: String(app?.mode || 'embedded'),
    entry: app?.entry == null ? null : String(app.entry),
    command: app?.command == null ? null : String(app.command),
    args: Array.isArray(app?.args) ? app.args.map(String) : [],
    env: isPlainObject(app?.env) ? serializableClone(app.env) : {},
    preset: app?.preset == null ? null : String(app.preset),
    helper: app?.helper == null ? null : String(app.helper),
    actionTool: app?.actionTool == null ? null : String(app.actionTool),
    launchOnly: Boolean(app?.launchOnly),
    tools: Array.isArray(app?.tools) ? serializableClone(app.tools) : [],
    directory: String(app?.directory || ''),
    manifestPath: String(app?.manifestPath || ''),
    builtin: Boolean(app?.builtin),
  }
}

function serializableClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
