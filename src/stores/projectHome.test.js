import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useProjectHomeStore } from './projectHome.js'

let home, node, revision
const clone = value => JSON.parse(JSON.stringify(value))
const source = () => ({ node: clone(node), sourceRevision: String(revision) })
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(invoke).mockClear()
  revision = 1
  node = { id: 'atlas', kind: 'project', body: 'Agent context', properties: { home: { canvas: 'Hello' } }, provenance: { sourcePath: '/team/graph/atlas.md', sourceRevision: '1' } }
  home = useProjectHomeStore()
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'graph_source') return source()
    if (command === 'graph_update') {
      expect(args.patch.expectedSourcePath).toBe(node.provenance.sourcePath)
      expect(args.patch.expectedRevision).toBe(String(revision))
      expect(args.patch.body).toBeUndefined()
      node.properties.home = { ...args.patch.setProperties.home, updatedAt: '2026-09-19T00:00:00Z', updatedBy: args.actor }
      node.provenance.sourceRevision = String(++revision)
      return clone(node)
    }
  })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Project canvas saves', () => {
  it('autosaves only the canvas and preserves a new context', async () => {
    const entry = home.receive(node)
    home.edit(entry, 'A joke')
    node.body = 'New agent context'; revision++
    await vi.advanceTimersByTimeAsync(600)
    expect(node.body).toBe('New agent context')
    expect(node.properties.home.canvas).toBe('A joke')
    expect(entry.status).toBe('saved')
    expect(home.drafts).toEqual([])
  })
  it('keeps typing during a save and saves the next version', async () => {
    const entry = home.receive(node)
    home.edit(entry, 'First')
    let finish
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const saved = home.save(entry)
    home.edit(entry, 'Second')
    home.receive(node)
    expect(entry.canvas).toBe('Second')
    finish(source()); await saved
    expect(entry.canvas).toBe('Second')
    await vi.advanceTimersByTimeAsync(600)
    expect(node.properties.home.canvas).toBe('Second')
  })
  it('keeps both conflicting texts and requires an explicit choice', async () => {
    const entry = home.receive(node)
    home.edit(entry, 'My text')
    node.properties.home.canvas = 'Their text'; revision++
    expect(await home.save(entry)).toBe(false)
    expect(entry.canvas).toBe('My text')
    expect(entry.remote).toBe('Their text')
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'graph_update')).toBe(false)
    home.resolve(entry, true)
    expect(entry.canvas).toBe('Their text')
    expect(entry.recovery).toBe('My text')
    home.recover(entry)
    await home.save(entry)
    expect(node.properties.home.canvas).toBe('My text')
  })
  it('recovers failed drafts through session data without crossing source paths', async () => {
    const entry = home.receive(node)
    home.edit(entry, 'Unsaved')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(await home.save(entry)).toBe(false)
    const drafts = clone(home.drafts)
    home.entries = {}; home.restore(drafts)
    const restored = home.receive(node)
    expect(restored.canvas).toBe('Unsaved')
    const other = home.receive({ ...node, provenance: { sourcePath: '/other/graph/atlas.md' } })
    expect(other.canvas).toBe('Hello')
    await home.save(restored)
    expect(node.properties.home.canvas).toBe('Unsaved')
  })
  it('restores the draft if Home loaded before the session snapshot', async () => {
    home.receive(node)
    home.restore([{ id: node.id, path: node.provenance.sourcePath, base: 'Hello', canvas: 'Recovered text' }])
    expect(home.entries[node.provenance.sourcePath].canvas).toBe('Recovered text')
    await vi.advanceTimersByTimeAsync(600)
    expect(node.properties.home.canvas).toBe('Recovered text')
  })
  it('keeps an undo made during a write in the close snapshot', async () => {
    const entry = home.receive(node)
    home.edit(entry, 'Pending save')
    let finish
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const writing = home.save(entry)
    home.edit(entry, 'Hello')
    const snapshot = clone(home.drafts)
    expect(snapshot[0].canvas).toBe('Hello')
    finish(source()); await writing
    // The pending write completed after the close snapshot was captured.
    home.entries = {}; home.restore(snapshot)
    const restored = home.receive(node)
    expect(restored.remote).toBeNull()
    await home.save(restored)
    expect(node.properties.home.canvas).toBe('Hello')
  })
  it('does not copy Project context into a legacy empty canvas', () => {
    delete node.properties.home
    expect(home.receive(node).canvas).toBe('')
  })
})
