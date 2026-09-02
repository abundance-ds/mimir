import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  createGraphNode,
  graphContext,
  graphEvents,
  graphMigrationReport,
  graphNeighbors,
  openBusinessGraph,
  queryGraph,
  restoreGraphNode,
  updateGraphNode,
} from './businessGraph.js'

describe('business graph service', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
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
