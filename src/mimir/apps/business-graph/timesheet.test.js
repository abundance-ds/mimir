import { describe, expect, it } from 'vitest'
import cases from '../../../../src-tauri/tests/fixtures/timesheets.json'
import { buildTimeProperties, formatMinutes, hydrateTimeRows, localTimeDate, parseDuration, timeEntries, timeProblems, timeTotals, timesheetCsv } from './timesheet.js'
import { buildInspectorSave, hydrateInspectorDraft } from './graphInspectorPersistence.js'

describe('time sheets', () => {
  it.each(cases)('validates $name with the native fixture', ({ properties, valid }) => {
    expect(timeProblems(properties.period, properties.entries).length === 0).toBe(valid)
  })
  it.each([['90', 90], ['90m', 90], ['1h 30m', 90], ['1:30', 90], ['24h', 1440], ['0', null], ['1.5h', null], ['1:99', null], ['no', null], ['-30', null], ['', null]])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })
  it('calculates open and invoiced totals and marks partial totals incomplete', () => {
    const { entries, period } = cases[0].properties
    expect(timeTotals(entries)).toEqual({ open: 90, invoiced: 45, total: 135, incomplete: false })
    const invalid = [...entries, { id: 'bad', date: '2026-09-15', minutes: 60, description: '' }]
    expect(timeTotals(invalid, timeProblems(period, invalid))).toEqual({ open: 90, invoiced: 45, total: 135, incomplete: true })
    expect(formatMinutes(135)).toBe('2h 15m')
    expect(localTimeDate(new Date(2026, 8, 15, 0, 1))).toBe('2026-09-15')
  })
  it('preserves unknown row fields, notes, IDs, and unloaded relations through Details saves', () => {
    const node = { id: 'sheet', kind: 'timesheet', title: 'Sheet', body: 'Keep these notes.',
      relations: [{ relation: 'part_of', target: 'unmounted-project' }, { relation: 'assigned_to', target: 'alex' }],
      properties: { ...cases[0].properties, extra: 'kept by the Graph patch' }, provenance: { sourceRevision: 'rev-1' } }
    const draft = {}
    hydrateInspectorDraft(draft, node)
    draft.timeRows[0].duration = '2h 15m'
    draft.timeRows[0].editedDuration = true
    const { payload } = buildInspectorSave({ node, nodes: [], draft, tags: [] })
    expect(payload.body).toBe(node.body)
    expect(payload.expectedRevision).toBe('rev-1')
    expect(payload.relations.map(edge => edge.target)).toEqual(['unmounted-project', 'alex'])
    expect(payload.setProperties.entries[0]).toEqual({ ...node.properties.entries[0], minutes: 135 })
    expect(payload.setProperties.entries[1].invoice).toBe('INV-014')
    expect(payload.removeProperties).not.toContain('extra')
    expect(JSON.stringify(payload)).not.toMatch(/editedDuration|timeRows|"total"/)
  })
  it('keeps invalid text in the draft and refuses to save it as zero', () => {
    const rows = hydrateTimeRows(cases[0].properties.entries)
    rows[0].duration = '1h?'; rows[0].editedDuration = true
    expect(timeEntries(rows)[0].minutes).toBeNull()
    expect(() => buildTimeProperties({ timePeriod: '2026-09', timeRows: rows })).toThrow('Row 1: Enter a duration')
    expect(rows[0].duration).toBe('1h?')
    expect(buildTimeProperties({ timePeriod: '2026-09', timeRows: rows }, { validate: false }).entries[0].minutes).toBe('1h?')
  })
  it('exports selected rows with exact minutes, a total, quoting, and safe text cells', () => {
    const entry = { ...cases[0].properties.entries[0], description: '=SUM(A1)\n"quoted", work' }
    const csv = timesheetCsv({ title: 'Sheet', project: 'Atlas', person: 'Alex', period: '2026-09', entries: [entry] })
    expect(csv).toContain('"\'=SUM(A1)\n""quoted"", work"')
    expect(csv).toContain('"90","1h 30m"')
    expect(csv).toContain('"Total","90","1h 30m"')
    expect(csv).not.toContain('INV-014')
    expect(() => timesheetCsv({ period: '2026-09', entries: [{ ...entry, minutes: null }] })).toThrow('Correct the time sheet')
  })
})
