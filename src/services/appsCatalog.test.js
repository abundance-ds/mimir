import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  createLocalApp,
  createAppActivity,
  duplicateLocalApp,
  dynamicToolDefinitions,
  embeddedAppUrl,
  invokeAppCommand,
  listenForAppTools,
  loadAppsCatalog,
  trashLocalApp,
  updateLocalAppTitle,
} from './appsCatalog.js'

describe('appsCatalog service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset()
  })

  it('normalizes and sorts the Rust catalog without losing manifest tools', async () => {
    vi.mocked(invoke).mockResolvedValue({
      directory: '/home/me/.mim/apps',
      apps: [
        { id: 'z', title: 'Zulu', mode: 'process', tools: [] },
        {
          id: 'a',
          title: 'Alpha',
          mode: 'embedded',
          tools: [{ name: 'read', inputSchema: { type: 'object' } }],
        },
      ],
      diagnostics: [{ path: '/bad/app.toml', field: 'entry', message: 'Missing' }],
    })

    const catalog = await loadAppsCatalog()

    expect(catalog.apps.map((app) => app.id)).toEqual(['a', 'z'])
    expect(catalog.apps[0].tools[0].name).toBe('read')
    expect(catalog.diagnostics[0]).toEqual({
      path: '/bad/app.toml',
      field: 'entry',
      message: 'Missing',
    })
  })

  it('maps manifest tools to canonical app-owned registry definitions', () => {
    expect(dynamicToolDefinitions('scratch', [{
      name: 'read',
      description: 'Read the note.',
      inputSchema: { type: 'object', properties: {} },
      mcpAlias: 'scratch_read',
    }])).toEqual([{
      canonicalName: 'app.scratch.read',
      mcpAlias: 'scratch_read',
      description: 'Read the note.',
      inputSchema: { type: 'object', properties: {} },
    }])
  })

  it('routes local definition mutations to the native catalog and normalizes every result', async () => {
    vi.mocked(invoke).mockResolvedValue({
      directory: '/home/me/.mim/apps',
      apps: [{ id: 'notes', title: 'Notes', mode: 'embedded', builtin: false }],
      diagnostics: [],
    })

    await createLocalApp({ id: 'notes', title: 'Notes', description: 'Local notes' })
    await duplicateLocalApp('notes', { id: 'notes-copy', title: 'Notes Copy' })
    await updateLocalAppTitle('notes', 'Field Notes')
    await trashLocalApp('notes-copy')

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['app_create', { id: 'notes', title: 'Notes', description: 'Local notes' }],
      ['app_duplicate', { appId: 'notes', newId: 'notes-copy', title: 'Notes Copy' }],
      ['app_update_title', { appId: 'notes', title: 'Field Notes' }],
      ['app_trash', { appId: 'notes-copy' }],
    ])
  })

  it('builds a durable singleton Activity and a custom-protocol local URL', () => {
    const app = {
      id: 'ledger',
      title: 'Ledger',
      mode: 'embedded',
      entry: 'dist/index.html',
      tools: [],
    }
    const launch = { mode: 'embedded', appId: 'ledger', url: 'file:///tmp/ledger/dist/index.html' }

    expect(embeddedAppUrl(app, launch)).toBe('app://localhost/ledger/dist/index.html')
    expect(createAppActivity(app, launch, '/work')).toMatchObject({
      id: 'app:ledger',
      kind: 'app',
      retention: 'durable',
      workspacePath: '/work',
      source: { appId: 'ledger' },
      launch: { plan: launch },
    })
  })

  it('filters relay events to one exact app instance', async () => {
    const listeners = new Map()
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      listeners.set(name, handler)
      return vi.fn()
    })
    const onCall = vi.fn()
    await listenForAppTools({ appId: 'scratch', instanceId: 'one', onCall })

    listeners.get('mim://tool-relay-request')({
      payload: { id: 'wrong', target: { kind: 'app', app_id: 'scratch', instance_id: 'two' } },
    })
    listeners.get('mim://tool-relay-request')({
      payload: { id: 'right', target: { kind: 'app', app_id: 'scratch', instance_id: 'one' } },
    })

    expect(onCall).toHaveBeenCalledTimes(1)
    expect(onCall.mock.calls[0][0].id).toBe('right')
  })

  it('pins iframe data commands to the hosted app identity', async () => {
    vi.mocked(invoke).mockResolvedValue()

    await invokeAppCommand('ledger', 'app_data_save', {
      appId: 'spoofed',
      projectId: 'obsolete',
      key: 'state',
      value: '{}',
    })

    expect(invoke).toHaveBeenCalledWith('app_data_save', {
      appId: 'ledger',
      key: 'state',
      value: '{}',
    })
  })

  it('lets apps call the shared registry while pinning caller ownership', async () => {
    vi.mocked(invoke).mockResolvedValue({ result: { value: 42 }, error: null })

    await invokeAppCommand('ledger', 'tool_registry_call', {
      request: {
        tool: 'files.read',
        input: { path: 'README.md' },
        caller: { kind: 'internal' },
        cwd: '/work',
      },
    })

    expect(invoke).toHaveBeenCalledWith('tool_registry_call', {
      request: {
        tool: 'files.read',
        input: { path: 'README.md' },
        caller: { kind: 'app', id: 'ledger' },
        requestId: null,
        cwd: '/work',
        metadata: {},
      },
    })
  })
})
