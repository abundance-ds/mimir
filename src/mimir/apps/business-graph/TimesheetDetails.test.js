import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { graphDocumentState } from '../../../stores/graphDocuments.js'
import { hydrateInspectorDraft, buildInspectorSave } from './graphInspectorPersistence.js'
import GraphInspector from './GraphInspector.vue'
import GraphSelect from './GraphSelect.vue'
import { exportTimesheetCsv } from '../../../services/timesheetExport.js'

vi.mock('../../../services/timesheetExport.js', () => ({ exportTimesheetCsv: vi.fn(async () => true) }))
enableAutoUnmount(afterEach)
const properties = { period: '2026-09', entries: [
  { id: 't1', date: '2026-09-15', minutes: 90, description: 'Test the export', custom: 'keep' },
  { id: 't2', date: '2026-09-15', minutes: 45, description: 'Project meeting', invoice: 'INV-014' },
  { id: 't3', date: '2026-09-16', minutes: 30, description: 'Review changes' },
] }
function setup(overrides = {}) {
  const node = { id: 'sheet', kind: 'timesheet', title: 'Atlas September', body: 'Client reference: PO-1042.',
    properties: structuredClone(properties), relations: [{ relation: 'part_of', target: 'atlas' }, { relation: 'assigned_to', target: 'alex' }],
    provenance: { sourceRevision: 'v1', sourcePath: '/graph/sheet.md', scopeId: 'team:main' }, ...overrides }
  const file = reactive({ id: 'file', kind: 'graph', dirty: false, saveState: 'idle',
    graph: graphDocumentState({ node, sourceRevision: 'v1', bodyFrom: 0 }) })
  const wrapper = mount(GraphInspector, { props: { documentFile: file,
    nodes: [{ id: 'atlas', kind: 'project', title: 'Atlas' }, { id: 'alex', kind: 'person', title: 'Alex' }],
    onDraftChange: () => { file.dirty = true; file.graph.version++ },
  } })
  const control = name => wrapper.get(`[data-graph-control="time-${name}"]`)
  const payload = () => buildInspectorSave({ node: file.graph.node, nodes: wrapper.props('nodes'), draft: file.graph.draft, tags: [] }).payload
  return { wrapper, file, control, payload }
}
function filter(wrapper, value) {
  wrapper.findAllComponents(GraphSelect).find(component => component.props('ariaLabel') === 'Time row filter').vm.$emit('update:modelValue', value)
  return flushPromises()
}

describe('Time sheet Details', () => {
  it('edits durations through the Graph draft and preserves row metadata', async () => {
    const { wrapper, file, control, payload } = setup()
    expect(wrapper.get('[data-time-total]').text()).toBe('2h 45m')
    await control('duration-t1').setValue('2h 15m')
    expect(wrapper.get('[data-time-total]').text()).toBe('3h 30m')
    expect(payload().setProperties.entries[0]).toMatchObject({ id: 't1', minutes: 135, custom: 'keep' })
    expect(file.dirty).toBe(true)
    await control('duration-t1').setValue('wrong')
    expect(wrapper.get('[data-time-errors]').text()).toContain('Totals exclude invalid rows')
    expect(control('export').attributes('disabled')).toBeDefined()
    expect(() => payload()).toThrow('duration')
  })
  it('selects ranges and limits actions and exports to visible rows', async () => {
    const { wrapper, control } = setup()
    await control('select-t1').trigger('click')
    await control('select-t3').trigger('click', { shiftKey: true })
    expect(wrapper.get('[data-time-selected]').text()).toBe('Selected: 3 rows · 2h 45m')
    await filter(wrapper, 'open')
    expect(wrapper.find('[data-time-selected]').exists()).toBe(false)
    await control('select-all').trigger('click')
    expect(wrapper.get('[data-time-selected]').text()).toContain('2 rows · 2h')
    expect(wrapper.get('[data-time-invoiced]').text()).toBe('45m')
    await control('export').trigger('click')
    await flushPromises()
    const csv = vi.mocked(exportTimesheetCsv).mock.calls.at(-1)[1]
    expect(csv).toContain('Test the export')
    expect(csv).not.toContain('Project meeting')
    expect(csv).toContain('"Total","120","2h"')
  })
  it('marks only open selected rows invoiced, groups invoices, and reopens rows', async () => {
    const { wrapper, control, payload } = setup()
    await control('select-all').trigger('click')
    await control('mark-invoiced').trigger('click')
    await control('invoice-reference').setValue('INV-015')
    await wrapper.get('.time-invoice-form').trigger('submit')
    expect(payload().setProperties.entries.map(row => row.invoice)).toEqual(['INV-015', 'INV-014', 'INV-015'])
    expect(wrapper.get('[data-time-open]').text()).toBe('0m')
    await filter(wrapper, 'invoice:INV-015')
    expect(wrapper.findAll('[data-time-row]')).toHaveLength(2)
    await control('select-all').trigger('click')
    await control('mark-open').trigger('click')
    expect(payload().setProperties.entries.map(row => row.invoice)).toEqual([undefined, 'INV-014', undefined])
    expect(wrapper.find('[data-time-selected]').exists()).toBe(false)
  })
  it('duplicates as Open with a new ID and undoes deletion after a save hydration', async () => {
    const { wrapper, file, control, payload } = setup()
    await control('duplicate-t2').trigger('click')
    const rows = payload().setProperties.entries
    expect(rows).toHaveLength(4)
    expect(rows[2].id).not.toBe('t2')
    expect(rows[2].invoice).toBeUndefined()
    await control('delete-t1').trigger('click')
    const saved = { ...file.graph.node, properties: payload().setProperties }
    hydrateInspectorDraft(file.graph.draft, saved)
    await flushPromises()
    await control('undo').trigger('click')
    expect(payload().setProperties.entries[0].id).toBe('t1')
    await control('redo').trigger('click')
    expect(payload().setProperties.entries[0].id).toBe('t2')
    file.graph.draft.timeRows[0].entry.description = 'Changed in Source'
    await flushPromises()
    expect(control('undo').attributes('disabled')).toBeDefined()
  })
  it('keeps malformed source rows intact and exposes a repair path', async () => {
    const { wrapper, file, control } = setup({ properties: { period: '2026-09', entries: [{ ...properties.entries[0] }, { ...properties.entries[0] }] } })
    expect(wrapper.text()).toContain('Repair the row structure in Source')
    expect(control('add').attributes('disabled')).toBeDefined()
    await control('repair-source').trigger('click')
    expect(wrapper.emitted('source')).toHaveLength(1)
    expect(file.graph.draft.timeRows).toHaveLength(2)
    expect(file.dirty).toBe(false)
  })
  it('adds a blank duration and keeps the draft until the user supplies the work and time', async () => {
    const { file, control, payload } = setup()
    await control('add').trigger('click')
    const row = file.graph.draft.timeRows.at(-1)
    expect(row.entry.id).toMatch(/^time-/)
    expect(row.entry.date).toMatch(/^2026-09-/)
    expect(row.entry.minutes).toBeNull()
    expect(() => payload()).toThrow('duration')
    await control(`duration-${row.entry.id}`).setValue('15m')
    await control(`work-${row.entry.id}`).setValue('Review')
    expect(payload().setProperties.entries.at(-1).minutes).toBe(15)
  })
})
