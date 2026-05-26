import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock services that would require Tauri / network
vi.mock('../../services/ai/modelControls', () => ({
  normalizeModelId: (id) => id || null,
  resolveDefaultModel: () => ({ id: 'test-model' }),
  modelMenuItems: () => [],
  modelDisplayName: (model) => model?.displayName || model?.name || model?.id || 'Model',
  providerConfigured: () => false,
  resolveConcreteModel: () => null,
  controlForModel: (_model, controlId) => ({
    kind: '', label: 'Control', default: 'none', id: controlId || 'none', option: null, options: [],
  }),
  defaultControlId: () => 'none',
}))

vi.mock('../../services/dataDir', () => ({
  deleteSession: vi.fn(() => Promise.resolve()),
}))

import { useSessionStore } from './sessions.js'
import { chatInstances, sessionStatusKind, proposalFinal, proposalRetryable } from './helpers.js'

beforeEach(() => {
  chatInstances.clear()
})

// ---- Proposal status transitions ----

describe('proposal status transitions', () => {
  it('pending -> accepted: sets status and proposalFinal returns true', () => {
    const store = useSessionStore()
    const session = store.createSession()
    store.selectSession(session.id)
    const proposal = { id: 'p1', status: 'pending' }
    session.proposals.push(proposal)

    store.setProposalStatus(proposal, 'accepted')
    expect(proposal.status).toBe('accepted')
    expect(proposalFinal(proposal)).toBe(true)
  })

  it('pending -> failed with failReason: sets both and proposalFinal returns true', () => {
    const store = useSessionStore()
    const session = store.createSession()
    store.selectSession(session.id)
    const proposal = { id: 'p2', status: 'pending' }
    session.proposals.push(proposal)

    store.setProposalStatus(proposal, 'failed', 'File not found')
    expect(proposal.status).toBe('failed')
    expect(proposal.failReason).toBe('File not found')
    expect(proposalFinal(proposal)).toBe(true)
  })

  it('pending -> rejected: sets status and proposalFinal returns true', () => {
    const store = useSessionStore()
    const session = store.createSession()
    store.selectSession(session.id)
    const proposal = { id: 'p3', status: 'pending' }
    session.proposals.push(proposal)

    store.setProposalStatus(proposal, 'rejected')
    expect(proposal.status).toBe('rejected')
    expect(proposalFinal(proposal)).toBe(true)
  })

  it('failed proposals are retryable', () => {
    expect(proposalRetryable({ status: 'failed' })).toBe(true)
    expect(proposalRetryable({ status: 'stale' })).toBe(true)
    expect(proposalRetryable({ status: 'conflict' })).toBe(true)
    expect(proposalRetryable({ status: 'pending' })).toBe(false)
    expect(proposalRetryable({ status: 'accepted' })).toBe(false)
    expect(proposalRetryable({ status: 'rejected' })).toBe(false)
  })
})

// ---- sessionStatusKind with proposals ----

describe('sessionStatusKind with proposals', () => {
  it('returns awaiting-review when session has a pending proposal', () => {
    const session = {
      id: 's1',
      lastError: '',
      proposals: [{ status: 'pending' }],
      _savedMessages: [],
    }
    expect(sessionStatusKind(session)).toBe('awaiting-review')
  })

  it('returns ready when all proposals are final and no messages', () => {
    const session = {
      id: 's2',
      lastError: '',
      proposals: [{ status: 'accepted' }],
      _savedMessages: [],
    }
    expect(sessionStatusKind(session)).toBe('ready')
  })

  it('returns awaiting-review with mixed statuses (one accepted + one pending)', () => {
    const session = {
      id: 's3',
      lastError: '',
      proposals: [{ status: 'accepted' }, { status: 'pending' }],
      _savedMessages: [],
    }
    expect(sessionStatusKind(session)).toBe('awaiting-review')
  })
})

// ---- findProposalById across sessions ----

describe('findProposalById across sessions', () => {
  it('finds proposal in non-active session', () => {
    const store = useSessionStore()
    const s1 = store.createSession()
    const s2 = store.createSession()

    s1.proposals.push({ id: 'prop_in_s1', status: 'pending' })
    // Select s2 so s1 is not the active session
    store.selectSession(s2.id)

    const found = store.findProposalById('prop_in_s1')
    expect(found).not.toBeNull()
    expect(found.id).toBe('prop_in_s1')
    expect(found.status).toBe('pending')
  })

  it('returns null for nonexistent proposal ID', () => {
    const store = useSessionStore()
    store.createSession()
    store.createSession()

    expect(store.findProposalById('does_not_exist')).toBeNull()
  })
})

// ---- Proposal result event pattern ----

describe('proposal result event pattern', () => {
  it('simulates proposal-result event: applied -> accepted, not-found -> failed', () => {
    const store = useSessionStore()
    const session = store.createSession()
    store.selectSession(session.id)

    const proposal1 = { id: 'evt_1', status: 'pending' }
    const proposal2 = { id: 'evt_2', status: 'pending' }
    session.proposals.push(proposal1, proposal2)

    // Simulate the 'applied' result path from persistence.js
    const found1 = store.findProposalById('evt_1')
    expect(found1).not.toBeNull()
    store.setProposalStatus(found1, 'accepted')
    expect(found1.status).toBe('accepted')
    expect(proposalFinal(found1)).toBe(true)

    // Simulate the 'not-found' / failure result path
    const found2 = store.findProposalById('evt_2')
    expect(found2).not.toBeNull()
    store.setProposalStatus(found2, 'failed', 'Apply failed')
    expect(found2.status).toBe('failed')
    expect(found2.failReason).toBe('Apply failed')
    expect(proposalFinal(found2)).toBe(true)
    expect(proposalRetryable(found2)).toBe(true)
  })
})
