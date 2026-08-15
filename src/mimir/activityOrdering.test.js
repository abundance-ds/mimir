import { describe, expect, it } from 'vitest'
import {
  moveActivityId,
  orderActivities,
  reorderActivityIds,
} from './activityOrdering.js'

const alpha = {
  id: 'agent:alpha',
  title: 'Alpha',
  status: 'working',
  createdAt: '2026-07-25T08:00:00Z',
  updatedAt: '2026-07-25T10:00:00Z',
}
const beta = {
  id: 'terminal:beta',
  title: 'Beta',
  status: 'needs-input',
  createdAt: '2026-07-25T08:30:00Z',
  updatedAt: '2026-07-25T09:00:00Z',
}
const gamma = {
  id: 'agent:gamma',
  title: 'gamma',
  status: 'done',
  createdAt: '2026-07-25T09:30:00Z',
  updatedAt: '2026-07-25T11:00:00Z',
}

describe('Activity ordering', () => {
  it('overlays manual order without cloning live Activity records', () => {
    const result = orderActivities([alpha, beta, gamma], {
      mode: 'manual',
      manualOrder: [beta.id, alpha.id],
    })

    expect(result.map((activity) => activity.id)).toEqual([gamma.id, beta.id, alpha.id])
    expect(result[1]).toBe(beta)
    expect(result[1].status).toBe('needs-input')
  })

  it('holds rows without a manual position steady when updatedAt moves', () => {
    const ids = (rows) => orderActivities(rows, { mode: 'manual', manualOrder: [] })
      .map((activity) => activity.id)
    // Live output bumps updatedAt on the oldest row several times a second.
    const busyAlpha = { ...alpha, updatedAt: '2026-07-25T12:00:00Z' }

    expect(ids([alpha, beta, gamma])).toEqual([gamma.id, beta.id, alpha.id])
    expect(ids([busyAlpha, beta, gamma])).toEqual([gamma.id, beta.id, alpha.id])
  })

  it('offers deterministic recent, attention, and name views', () => {
    expect(orderActivities([alpha, beta, gamma], { mode: 'recent' }).map(({ id }) => id))
      .toEqual([gamma.id, alpha.id, beta.id])
    expect(orderActivities([alpha, beta, gamma], {
      mode: 'attention',
      blockingInputActivityIds: new Set([beta.id]),
    }).map(({ id }) => id))
      .toEqual([beta.id, alpha.id, gamma.id])
    expect(orderActivities([alpha, beta, gamma], { mode: 'attention' }).map(({ id }) => id))
      .toEqual([alpha.id, beta.id, gamma.id])
    expect(orderActivities([gamma, beta, alpha], { mode: 'name' }).map(({ id }) => id))
      .toEqual([alpha.id, beta.id, gamma.id])
  })

  it('does not promote a restoring row as active work', () => {
    const recentIdle = {
      ...beta,
      status: 'idle',
      updatedAt: '2026-07-25T12:00:00Z',
    }

    expect(orderActivities([alpha, recentIdle], { mode: 'attention' }).map(({ id }) => id))
      .toEqual([alpha.id, recentIdle.id])
    expect(orderActivities([alpha, recentIdle], {
      mode: 'attention',
      restoringActivityIds: new Set([alpha.id]),
    }).map(({ id }) => id))
      .toEqual([recentIdle.id, alpha.id])
  })

  it('reorders by stable id for pointer and keyboard moves', () => {
    const ids = [alpha.id, beta.id, gamma.id]

    expect(reorderActivityIds(ids, gamma.id, beta.id))
      .toEqual([alpha.id, gamma.id, beta.id])
    expect(reorderActivityIds(ids, alpha.id, null))
      .toEqual([beta.id, gamma.id, alpha.id])
    expect(moveActivityId(ids, beta.id, -1))
      .toEqual([beta.id, alpha.id, gamma.id])
    expect(moveActivityId(ids, alpha.id, -1)).toEqual(ids)
  })
})
