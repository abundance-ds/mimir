import { describe, expect, it } from 'vitest'
import {
  appendMarkdownBelow,
  journalDay,
  journalDates,
  journalNodeId,
  parseTodayStorage,
  shiftDateKey,
  stripCheckedTasks,
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

  it('strips checked tasks and preserves all other content', () => {
    const result = stripCheckedTasks([
      '# Friday',
      '',
      '## Work',
      '- [ ] Open parent',
      '  - [x] Finished child',
      '  - [ ] Open child',
      '- [x] Finished parent',
      '  - [ ] Still open',
      '',
      '## Notes',
      'Talked to Sarah.',
    ].join('\n'))

    expect(result).toBe([
      '# Friday',
      '',
      '## Work',
      '- [ ] Open parent',
      '  - [ ] Open child',
      '  - [ ] Still open',
      '',
      '## Notes',
      'Talked to Sarah.',
    ].join('\n'))
  })

  it('strips checked tasks with non-task children', () => {
    const result = stripCheckedTasks([
      '- [x] Deploy staging',
      '  Had to fix the config.',
      '  Monitoring looks good.',
      '- [ ] Write docs',
    ].join('\n'))

    expect(result).toBe('- [ ] Write docs')
  })

  it('returns empty string when all tasks are checked', () => {
    expect(stripCheckedTasks('- [x] Done\n- [x] Also done')).toBe('')
  })

  it('returns full text when nothing is checked', () => {
    const input = '# Plan\n\n- [ ] Task A\n\nSome notes.'
    expect(stripCheckedTasks(input)).toBe(input)
  })

  it('excludes additional line ranges when provided', () => {
    const input = [
      '# Day',
      '- [ ] Keep this',
      '- [ ] Skip this',
      '- [x] Done',
      'Notes.',
    ].join('\n')
    const result = stripCheckedTasks(input, [{ start: 2, end: 3 }])
    expect(result).toBe([
      '# Day',
      '- [ ] Keep this',
      'Notes.',
    ].join('\n'))
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

  it('lists valid Journal dates once in chronological order', () => {
    expect(journalDates([
      '## 2026-08-15',
      '',
      'Later.',
      '',
      '## 2026-08-14',
      '',
      'Earlier.',
      '',
      '## 2026-02-31',
      '',
      'Invalid.',
    ].join('\n'))).toEqual(['2026-08-14', '2026-08-15'])
  })
})
