import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGraphNode,
  getGraphNode,
  updateGraphNode,
} from '../../services/businessGraph.js'
import {
  archiveTodayEntry,
  loadTodayEntry,
  loadTodayMonthDates,
} from './todayJournal.js'

vi.mock('../../services/businessGraph.js', () => ({
  createGraphNode: vi.fn(),
  getGraphNode: vi.fn(),
  updateGraphNode: vi.fn(),
}))

describe('todayJournal', () => {
  beforeEach(() => {
    vi.mocked(createGraphNode).mockReset()
    vi.mocked(getGraphNode).mockReset()
    vi.mocked(updateGraphNode).mockReset()
  })

  it('creates one monthly private journal node', async () => {
    vi.mocked(getGraphNode).mockResolvedValue(null)
    vi.mocked(createGraphNode).mockImplementation(async create => create)

    await archiveTodayEntry({
      date: '2026-08-14',
      text: '- [ ] Finish this',
      timeZone: 'Europe/Berlin',
    })

    expect(createGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'journal-2026-08',
      scopeId: 'private:local',
      kind: 'journal',
      title: 'August 2026',
      tags: ['today'],
      properties: {
        artifactType: 'today-journal',
        sourceAppId: 'scratch',
        timeZone: 'Europe/Berlin',
      },
      body: '## 2026-08-14\n\n- [ ] Finish this\n',
    }))
  })

  it('updates an existing month with revision checking', async () => {
    vi.mocked(getGraphNode).mockResolvedValue({
      id: 'journal-2026-08',
      body: '## 2026-08-13\n\nEarlier.\n',
      tags: ['personal'],
      provenance: { sourceRevision: 'rev-1' },
    })
    vi.mocked(updateGraphNode).mockImplementation(async patch => patch)

    await archiveTodayEntry({ date: '2026-08-14', text: 'Later.' })

    expect(updateGraphNode).toHaveBeenCalledWith(expect.objectContaining({
      id: 'journal-2026-08',
      expectedRevision: 'rev-1',
      tags: ['personal', 'today'],
      body: expect.stringContaining('## 2026-08-14\n\nLater.'),
    }))
  })

  it('retries a create collision as an update', async () => {
    vi.mocked(getGraphNode)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'journal-2026-08',
        kind: 'journal',
        body: '',
        tags: [],
        provenance: { sourceRevision: 'rev-2' },
      })
    vi.mocked(createGraphNode).mockRejectedValue(new Error('already exists'))
    vi.mocked(updateGraphNode).mockResolvedValue({ id: 'journal-2026-08' })

    await archiveTodayEntry({ date: '2026-08-14', text: 'Recovered.' })

    expect(updateGraphNode).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a non-journal node with the monthly id', async () => {
    vi.mocked(getGraphNode).mockResolvedValue({
      id: 'journal-2026-08',
      kind: 'note',
      body: 'Keep this note.',
    })

    await expect(archiveTodayEntry({
      date: '2026-08-14',
      text: 'Do not write this.',
    })).rejects.toThrow('belongs to a note')
    expect(updateGraphNode).not.toHaveBeenCalled()
  })

  it('loads one date from its monthly journal', async () => {
    vi.mocked(getGraphNode).mockResolvedValue({
      body: '## 2026-08-13\n\nEarlier.\n\n## 2026-08-14\n\nYesterday.\n',
    })

    await expect(loadTodayEntry('2026-08-14')).resolves.toBe('Yesterday.')
  })

  it('loads the available dates for one calendar month', async () => {
    vi.mocked(getGraphNode).mockResolvedValue({
      body: [
        '## 2026-08-13',
        '',
        'Earlier.',
        '',
        '## 2026-08-15',
        '',
        'Today.',
      ].join('\n'),
    })

    await expect(loadTodayMonthDates('2026-08')).resolves.toEqual([
      '2026-08-13',
      '2026-08-15',
    ])
    expect(getGraphNode).toHaveBeenCalledWith('journal-2026-08')
  })
})
