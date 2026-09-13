import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { loadIpcFixture } from '../test/ipcFixtures.js'
import {
  createGraphNode,
  graphContext,
  graphEvents,
  graphMigrationReport,
  graphNeighbors,
  graphLinkTargets,
  graphReferences,
  lookupGraph,
  moveGraphNodeScope,
  openBusinessGraph,
  queryGraph,
  restoreGraphNode,
  serializeGraphSource,
  updateGraphNode,
} from './businessGraph.js'

describe('business graph service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
  })

  it('formats a recovery draft through the native serializer without a source write', async () => {
    const node = loadIpcFixture('graph_source').node
    const content = loadIpcFixture('graph_source_serialize')
    vi.mocked(invoke).mockResolvedValueOnce(content)
    expect(await serializeGraphSource(node)).toBe(content)
    expect(invoke).toHaveBeenCalledWith('graph_source_serialize', { node })
  })

  it('retains the source identity and revision when moving a Details document', async () => {
    const request = { id: 'meeting', targetScopeId: 'team:main', expectedRevision: 'r1', expectedSourcePath: '/project/graph/meeting.md' }
    await moveGraphNodeScope(request)
    expect(invoke).toHaveBeenCalledWith('graph_move_scope', { request, actor: expect.objectContaining({ kind: 'human' }) })
  })

  it('mounts the project while native code owns the fixed Team root', async () => {
    await openBusinessGraph('/work/project')
    expect(invoke).toHaveBeenCalledWith('graph_open', {
      projectRoot: '/work/project',
    })
  })

  it('normalizes bounded query scope, kind, tag, and pagination inputs', async () => {
    await queryGraph({
      scopeIds: ['private:local', 'private:local'],
      kinds: ['issue'],
      tags: ['heor'],
      offset: -5,
      limit: 5000,
    })
    expect(invoke).toHaveBeenCalledWith('graph_query', {
      query: {
        scopeIds: ['private:local'],
        kinds: ['issue'],
        tags: ['heor'],
        offset: 0,
        limit: 500,
      },
    })
  })

  it('normalizes bounded change-history pagination', async () => {
    await graphEvents({
      scopeIds: ['project:test', 'project:test'],
      since: '2026-07-20T00:00:00Z',
      offset: -20,
      limit: 5000,
    })
    expect(invoke).toHaveBeenCalledWith('graph_events', {
      query: {
        scopeIds: ['project:test'],
        since: '2026-07-20T00:00:00Z',
        offset: 0,
        limit: 500,
      },
    })
  })

  it('passes typed creates, optimistic patches, and scoped traversal unchanged', async () => {
    const create = { scopeId: 'project:test', kind: 'project', title: 'Alpha' }
    const patch = { id: 'alpha', expectedRevision: 'abc', title: 'Alpha 2' }
    await createGraphNode(create)
    await updateGraphNode(patch)
    await graphNeighbors('alpha', { scopeIds: ['project:test'] })

    expect(invoke).toHaveBeenNthCalledWith(1, 'graph_create', {
      create,
      actor: expect.objectContaining({ kind: 'human' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'graph_update', {
      patch,
      actor: expect.objectContaining({ kind: 'human' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'graph_neighbors', {
      id: 'alpha',
      scopeIds: ['project:test'],
    })
  })

  it('preserves native lookup and resolution payloads', async () => {
    const lookup = loadIpcFixture('graph_lookup')
    const targets = loadIpcFixture('graph_link_targets')
    vi.mocked(invoke).mockResolvedValueOnce(lookup).mockResolvedValueOnce(targets)
    expect(await lookupGraph('jo')).toEqual(lookup)
    expect(await graphLinkTargets(['person-jon', 'missing'])).toEqual(targets)
  })

  it('uses native title lookup and scoped reference queries with bounded results', async () => {
    await lookupGraph(' jo ', { scopeIds: ['team:main', 'team:main'], limit: 5000 })
    await graphLinkTargets(['jon', 'jon', 'jolo'], { scopeIds: ['team:main'] })
    await graphReferences('note', { scopeIds: ['team:main'] })
    expect(invoke).toHaveBeenNthCalledWith(1, 'graph_lookup', { query: 'jo', scopeIds: ['team:main'], limit: 50 })
    expect(invoke).toHaveBeenNthCalledWith(2, 'graph_link_targets', { ids: ['jon', 'jolo'], scopeIds: ['team:main'] })
    expect(invoke).toHaveBeenNthCalledWith(3, 'graph_references', { id: 'note', scopeIds: ['team:main'] })
  })

  it('uses one opaque undo token to restore a recently Trashed source', async () => {
    await restoreGraphNode('undo-123')
    expect(invoke).toHaveBeenCalledWith('graph_restore', {
      request: { undoToken: 'undo-123' },
      actor: expect.objectContaining({ kind: 'human' }),
    })
  })

  it('requests the native dry-run migration inventory without client-side rewriting', async () => {
    await graphMigrationReport()
    expect(invoke).toHaveBeenCalledWith('graph_migration_report')
  })

  it('normalizes a bounded graph context request for agent handoff', async () => {
    await graphContext({
      focusId: 'issue-1',
      scopeIds: ['project:test', 'project:test'],
      maxNodes: 1000,
    })
    expect(invoke).toHaveBeenCalledWith('graph_context', {
      request: {
        focusId: 'issue-1',
        scopeIds: ['project:test'],
        maxNodes: 40,
      },
    })
  })
})
