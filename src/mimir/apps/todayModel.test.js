import { describe, expect, it } from 'vitest'
import {
  appendMarkdownBelow,
  journalDay,
  journalNodeId,
  parseTodayStorage,
  shiftDateKey,
  uncheckedTaskBlocks,
  upsertJournalDay,
} from './todayModel.js'

describe('todayModel', () => {
  it('migrates version 1 data using the local update date', () => {
    const state = parseTodayStorage(JSON.stringify({
      version: 1,
      text: '- [ ] Ship it',
      updatedAt: '2026-08-14T18:00:00.000Z',
    }), '2026-08-15')

    expect(state).toMatchObject({
      version: 3,
      date: '2026-08-14',
      text: '- [ ] Ship it',
      previous: null,
      archiveQueue: [],
      tomorrow: null,
    })
  })

  it('keeps one dated Tomorrow draft in version 3 storage', () => {
    const state = parseTodayStorage(JSON.stringify({
      version: 3,
      date: '2026-08-15',
      text: 'Today.',
      tomorrow: {
        date: '2026-08-16',
        text: 'Tomorrow.',
        updatedAt: '2026-08-15T12:00:00.000Z',
      },
    }), '2026-08-15')

    expect(state.tomorrow).toEqual({
      date: '2026-08-16',
      text: 'Tomorrow.',
      updatedAt: '2026-08-15T12:00:00.000Z',
    })
  })

  it('appends Markdown with one plain separator and no smart merge', () => {
    expect(appendMarkdownBelow('Tomorrow plan.\n', '- [ ] Carried task')).toBe(
      'Tomorrow plan.\n\n- [ ] Carried task',
    )
    expect(appendMarkdownBelow('', '- [ ] Carried task')).toBe('- [ ] Carried task')
    expect(appendMarkdownBelow('Tomorrow plan.', '')).toBe('Tomorrow plan.')
  })

  it('shifts local date keys across daylight-saving changes', () => {
    expect(shiftDateKey('2026-03-29', 1)).toBe('2026-03-30')
    expect(shiftDateKey('2026-10-25', -1)).toBe('2026-10-24')
    expect(journalNodeId('2026-08-15')).toBe('journal-2026-08')
  })

  it('carries only root unchecked task blocks', () => {
    const blocks = uncheckedTaskBlocks([
      '# Friday',
      '',
      '- [ ] Open parent',
      '  Context for the parent.',
      '  - [x] Finished child',
      '  - [ ] Open child',
      '- [x] Finished parent',
      '  - [ ] Child that is still open',
      '',
      'Ordinary prose.',
    ].join('\n'))

    expect(blocks).toHaveLength(2)
    expect(blocks[0].markdown).toBe([
      '- [ ] Open parent',
      '  Context for the parent.',
      '  - [x] Finished child',
      '  - [ ] Open child',
    ].join('\n'))
    expect(blocks[1].markdown).toBe('- [ ] Child that is still open')
  })

  it('supports ordered task lists and excludes ordinary prose', () => {
    const blocks = uncheckedTaskBlocks([
      'Plan for tomorrow.',
      '1. [ ] First step',
      '2. [x] Second step',
    ].join('\n'))

    expect(blocks.map(block => block.markdown)).toEqual(['1. [ ] First step'])
  })

  it('adds, replaces, and reads an idempotent journal day section', () => {
    const initial = upsertJournalDay('', '2026-08-14', '- [ ] First')
    const replaced = upsertJournalDay(initial, '2026-08-14', '- [x] First')
    const appended = upsertJournalDay(replaced, '2026-08-15', 'A short note.')

    expect(journalDay(appended, '2026-08-14')).toBe('- [x] First')
    expect(journalDay(appended, '2026-08-15')).toBe('A short note.')
    expect(upsertJournalDay(appended, '2026-08-15', 'A short note.')).toBe(appended)
  })
})
