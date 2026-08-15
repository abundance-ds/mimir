import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  useActivitiesStore,
} from './activities.js'

const base = {
  id: 'agent:one',
  kind: 'agent',
  title: 'Codex',
  titleSource: 'launcher',
  workspacePath: '/work',
  status: 'ready',
  createdAt: '2026-07-25T10:00:00.000Z',
  updatedAt: '2026-07-25T10:00:00.000Z',
  lastViewedAt: null,
  archivedAt: null,
  closeRequestedAt: null,
  retention: 'durable',
  source: { launcherId: 'codex', presetId: 'codex' },
  host: { type: 'pty', resumeStrategy: 'codex' },
  launch: {
    command: '/opt/bin/codex',
    args: ['--full-auto'],
    cwd: '/work',
    env: { MIMIR_ACTIVITY_ID: 'agent:one' },
  },
}

describe('activities store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('publishes the complete kind and status vocabularies', () => {
    expect(ACTIVITY_KINDS).toEqual(['terminal', 'agent', 'files', 'app', 'routine', 'chat'])
    expect(ACTIVITY_STATUSES).toEqual([
      'ready',
      'starting',
      'working',
      'needs-input',
      'idle',
      'done',
      'error',
      'stopped',
      'interrupted',
    ])
  })

  it('upserts serializable backend records and keeps newest activity first', () => {
    const store = useActivitiesStore()
    store.upsert(base)
    store.upsert({
      ...base,
      id: 'terminal:two',
      kind: 'terminal',
      title: 'Terminal',
      retention: 'ephemeral',
      updatedAt: '2026-07-25T11:00:00.000Z',
    })

    expect(store.activities.map((item) => item.id)).toEqual(['terminal:two', 'agent:one'])
    expect(JSON.parse(JSON.stringify(store.byId('agent:one')))).toEqual(store.byId('agent:one'))
  })

  it('migrates the old automatic-title eligibility field', () => {
    const store = useActivitiesStore()

    const migrated = store.upsert({
      ...base,
      titleSource: undefined,
      autoTitleEligible: true,
    })

    expect(migrated.titleSource).toBe('launcher')
    expect(migrated).not.toHaveProperty('autoTitleEligible')

    const locked = store.upsert({
      ...base,
      id: 'agent:locked-legacy',
      titleSource: undefined,
      autoTitleEligible: false,
    })
    expect(locked.titleSource).toBe('manual')
  })

  it('skips the write when the backend re-emits an identical record', () => {
    const store = useActivitiesStore()
    store.upsert(base)
    const storedRecord = store.byId('agent:one')
    const storedArray = store.records

    const result = store.upsert({ ...base, launch: { ...base.launch } })

    expect(result).toBe(storedRecord)
    expect(store.records).toBe(storedArray)
  })

  it('notifies reactive consumers when an upsert changes a record', async () => {
    const store = useActivitiesStore()
    store.upsert(base)

    const seen = []
    const stop = watch(
      () => store.records.map((item) => `${item.id}:${item.status}`).join('|'),
      (value) => seen.push(value),
    )

    store.upsert({ ...base }) // identical: must not notify
    await nextTick()
    expect(seen).toEqual([])

    store.upsert({ ...base, status: 'starting', updatedAt: '2026-07-25T10:01:00.000Z' })
    await nextTick()
    expect(seen).toEqual(['agent:one:starting'])
    stop()
  })

  it('rejects non-cloneable metadata payloads', () => {
    const store = useActivitiesStore()

    expect(() => store.upsert({
      ...base,
      source: { onDone() {} },
    })).toThrow(/serializable/i)
  })

  it('does not persist renderer runtime handles in activity records', () => {
    const store = useActivitiesStore()

    expect(() => store.upsert({
      ...base,
      terminal: { dispose() {} },
    })).toThrow(/unknown activity field/i)
  })

  it('merges authoritative updates without losing launch metadata', () => {
    const store = useActivitiesStore()
    store.upsert(base)
    store.upsert({
      id: 'agent:one',
      kind: 'agent',
      title: 'Review the protocol',
      workspacePath: '/work',
      status: 'working',
      updatedAt: '2026-07-25T10:02:00.000Z',
    })

    expect(store.byId('agent:one')).toMatchObject({
      title: 'Review the protocol',
      status: 'working',
      launch: base.launch,
      source: base.source,
    })
  })

  it('enforces local lifecycle transitions', () => {
    const store = useActivitiesStore()
    store.upsert(base)

    store.transition('agent:one', 'starting')
    store.transition('agent:one', 'working')
    store.transition('agent:one', 'needs-input')
    store.transition('agent:one', 'working')
    store.transition('agent:one', 'done')
    store.transition('agent:one', 'starting')

    expect(store.byId('agent:one').status).toBe('starting')
  })

  it('rejects impossible local lifecycle transitions', () => {
    const store = useActivitiesStore()
    store.upsert(base)

    expect(() => store.transition('agent:one', 'done')).toThrow(/ready.*done/i)
    expect(() => store.transition('missing', 'working')).toThrow(/not found/i)
  })

  it('allows authoritative backend events to reconcile any status', () => {
    const store = useActivitiesStore()
    store.upsert(base)

    store.reconcileStatus('agent:one', 'interrupted', '2026-07-25T12:00:00.000Z')

    expect(store.byId('agent:one')).toMatchObject({
      status: 'interrupted',
      updatedAt: '2026-07-25T12:00:00.000Z',
    })
  })

  it('archives and restores durable activities without deleting their records', () => {
    const store = useActivitiesStore()
    store.upsert(base)

    store.setArchived('agent:one', true, '2026-07-25T12:00:00.000Z')
    expect(store.visibleActivities).toEqual([])
    expect(store.archivedActivities.map((item) => item.id)).toEqual(['agent:one'])

    store.setArchived('agent:one', false)
    expect(store.visibleActivities.map((item) => item.id)).toEqual(['agent:one'])
  })

  it('hides a durable close intent and finalizes it during hydration', () => {
    const store = useActivitiesStore()
    const requestedAt = '2026-07-25T12:00:00.000Z'
    store.upsert({ ...base, closeRequestedAt: requestedAt })
    expect(store.visibleActivities).toEqual([])
    expect(store.archivedActivities).toEqual([])

    store.hydrate([{ ...base, closeRequestedAt: requestedAt }])
    expect(store.byId('agent:one')).toMatchObject({
      archivedAt: requestedAt,
      closeRequestedAt: null,
      status: 'interrupted',
    })
  })

  it('creates a durable snapshot that excludes ephemeral terminals', () => {
    const store = useActivitiesStore()
    store.upsert(base)
    store.upsert({
      ...base,
      id: 'terminal:two',
      kind: 'terminal',
      title: 'Terminal',
      retention: 'ephemeral',
    })

    expect(store.durableSnapshot().map((item) => item.id)).toEqual(['agent:one'])
  })

  it('hydrates records and reconciles stale live sessions to interrupted', () => {
    const store = useActivitiesStore()

    store.hydrate([
      { ...base, status: 'working' },
      {
        ...base,
        id: 'routine:two',
        kind: 'routine',
        title: 'Morning review',
        status: 'done',
      },
    ])

    expect(store.byId('agent:one').status).toBe('interrupted')
    expect(store.byId('routine:two').status).toBe('done')
  })

  it('removes ended records but protects live work from accidental deletion', () => {
    const store = useActivitiesStore()
    store.upsert({ ...base, status: 'working' })

    expect(() => store.remove('agent:one')).toThrow(/live activity/i)
    store.reconcileStatus('agent:one', 'stopped')
    store.remove('agent:one')
    expect(store.byId('agent:one')).toBeNull()
  })

  it('rejects malformed records early', () => {
    const store = useActivitiesStore()

    expect(() => store.upsert({ ...base, id: '' })).toThrow(/id/i)
    expect(() => store.upsert({ ...base, kind: 'chatty' })).toThrow(/kind/i)
    expect(() => store.upsert({ ...base, status: 'paused' })).toThrow(/status/i)
    expect(() => store.upsert({ ...base, retention: 'forever' })).toThrow(/retention/i)
  })
})
