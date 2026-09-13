import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import GraphReferences from './GraphReferences.vue'
import { loadIpcFixture } from '../../../test/ipcFixtures.js'

const props = { node: { id: 'jon', provenance: { sourceRevision: 'jon-1' } }, scopeIds: ['team:main'], graphRevision: 1 }
const data = {
  sourceRevision: 'jon-1',
  outgoing: [
    { targetId: 'jolo', label: 'Old title', from: 0, to: 29, status: 'resolved', node: { id: 'jolo', title: 'Jolo', kind: 'company', scopeId: 'team:main' } },
    { targetId: 'jolo', label: 'Repeated title', from: 31, to: 60, status: 'resolved', node: { id: 'jolo', title: 'Jolo', kind: 'company', scopeId: 'team:main' } },
    { targetId: 'missing', label: 'Old contact', from: 61, to: 94, status: 'unavailable' },
  ],
  backlinks: [{ source: { id: 'note', title: 'Notes', kind: 'note', scopeId: 'team:main' }, sourceRevision: 'note-1', occurrences: [{ targetId: 'jon', label: 'Jon', from: 3, to: 27 }] }],
}
async function toggleGroup(wrapper, name, open = true) {
  const group = wrapper.get(`[data-graph-reference-group="${name}"]`)
  group.element.open = open
  await group.trigger('toggle')
}
beforeEach(() => { vi.mocked(invoke).mockReset() })
describe('Graph note references', () => {
  it('renders nothing for an empty snapshot, including an unsaved note', async () => {
    vi.mocked(invoke).mockResolvedValue({ outgoing: [], backlinks: [], sourceRevision: 'jon-1' })
    const wrapper = mount(GraphReferences, { props: { ...props, dirty: true } })
    expect(wrapper.find('section').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('section').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('starts with compact native disclosures and visible unavailable counts', async () => {
    vi.mocked(invoke).mockResolvedValue(data)
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    const links = wrapper.get('[data-graph-reference-group="links"]')
    const backlinks = wrapper.get('[data-graph-reference-group="backlinks"]')
    expect(links.element.tagName).toBe('DETAILS')
    expect(links.element.open).toBe(false)
    expect(backlinks.element.open).toBe(false)
    expect(links.get('summary').attributes('aria-label')).toBe('Links, 2, 1 unavailable')
    expect(links.get('.graph-reference-count').text()).toBe('2')
    expect(backlinks.get('summary').attributes('aria-label')).toBe('Backlinks, 1')
    expect(wrapper.find('[data-graph-outgoing-link]').exists()).toBe(false)
    expect(wrapper.find('[data-graph-backlink]').exists()).toBe(false)
    await toggleGroup(wrapper, 'links')
    expect(wrapper.findAll('[data-graph-outgoing-link]')).toHaveLength(2)
    await toggleGroup(wrapper, 'links', false)
    expect(wrapper.find('[data-graph-outgoing-link]').exists()).toBe(false)
    expect(links.get('summary').text()).toContain('1 unavailable')
    wrapper.unmount()
  })

  it('omits an empty group beside a populated one', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...data, outgoing: [] })
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    expect(wrapper.find('[data-graph-reference-group="links"]').exists()).toBe(false)
    expect(wrapper.get('[data-graph-control="note-backlinks-toggle"]').attributes('aria-label')).toBe('Backlinks, 1')
    expect(wrapper.text()).not.toContain('No links')
    wrapper.unmount()
  })

  it('reads flattened native reference records and native backlink revisions', async () => {
    const snapshot = loadIpcFixture('graph_references')
    vi.mocked(invoke).mockResolvedValue(snapshot)
    const wrapper = mount(GraphReferences, { props: { ...props, node: { id: 'note-source' } } })
    await flushPromises()
    await toggleGroup(wrapper, 'links')
    await toggleGroup(wrapper, 'backlinks')
    expect(wrapper.get('[data-graph-control="note-link-person-jon"]').text()).toContain('Jon Minton')
    expect(wrapper.get('[data-graph-control="note-link-missing"]').text()).toContain('Unavailable')
    await wrapper.get('[data-graph-backlink]').trigger('click')
    expect(wrapper.emitted('open')[0]).toEqual([{
      id: 'person-jon', targetId: 'note-source', sourceRevision: '4f6a2c88', from: 4, to: 45,
    }])
    wrapper.unmount()
  })

  it('shows distinct outgoing targets, missing links, and source-location backlinks', async () => {
    vi.mocked(invoke).mockResolvedValue(data)
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('graph_references', { id: 'jon', scopeIds: ['team:main'] })
    await toggleGroup(wrapper, 'links')
    await toggleGroup(wrapper, 'backlinks')
    expect(wrapper.findAll('[data-graph-outgoing-link]')).toHaveLength(2)
    expect(wrapper.get('[data-graph-control="note-link-missing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Unavailable')
    await wrapper.get('[data-graph-control="note-link-jolo"]').trigger('click')
    await wrapper.get('[data-graph-backlink]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['jolo'], [{ id: 'note', targetId: 'jon', sourceRevision: 'note-1', from: 3, to: 27 }]])
    wrapper.unmount()
  })
  it('discards late snapshots after a node or scope switch', async () => {
    const pending = []
    vi.mocked(invoke).mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    const wrapper = mount(GraphReferences, { props })
    await wrapper.setProps({ node: { id: 'elsewhere' }, scopeIds: ['private:local'] })
    pending[1]({ outgoing: [], backlinks: [], sourceRevision: 'other' })
    await flushPromises()
    pending[0](data)
    await flushPromises()
    expect(wrapper.text()).not.toContain('Jolo')
    expect(wrapper.findAll('[data-graph-backlink]')).toHaveLength(0)
    wrapper.unmount()
  })
  it('clears expanded rows immediately when scopes change and collapses the new snapshot', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(data)
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    await toggleGroup(wrapper, 'links')
    expect(wrapper.text()).toContain('Jolo')
    let finish
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await wrapper.setProps({ scopeIds: ['private:local'] })
    expect(wrapper.find('section').exists()).toBe(false)
    finish({ ...data, backlinks: [] })
    await flushPromises()
    expect(wrapper.get('[data-graph-reference-group="links"]').element.open).toBe(false)
    expect(wrapper.find('[data-graph-outgoing-link]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes saved links on revision changes without reading per draft keypress', async () => {
    vi.mocked(invoke).mockResolvedValue(data)
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    await wrapper.setProps({ dirty: true })
    expect(wrapper.text()).not.toContain('Links update after save.')
    await toggleGroup(wrapper, 'links')
    expect(wrapper.text()).toContain('Links update after save.')
    await toggleGroup(wrapper, 'backlinks')
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)
    await toggleGroup(wrapper, 'links', false)
    await toggleGroup(wrapper, 'backlinks', false)
    expect(wrapper.text()).not.toContain('Links update after save.')
    expect(invoke).toHaveBeenCalledTimes(1)
    vi.mocked(invoke).mockResolvedValue({ outgoing: [], backlinks: [], sourceRevision: 'jon-2' })
    await wrapper.setProps({ graphRevision: 2, dirty: false })
    await flushPromises()
    expect(wrapper.findAll('[data-graph-outgoing-link]')).toHaveLength(0)
    expect(invoke).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
  it('reports native failures and offers retry', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(data)
    const wrapper = mount(GraphReferences, { props })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Links could not be loaded.')
    await wrapper.get('[data-graph-control="note-links-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-graph-outgoing-link]')).toHaveLength(0)
    await toggleGroup(wrapper, 'links')
    expect(wrapper.findAll('[data-graph-outgoing-link]')).toHaveLength(2)
    wrapper.unmount()
  })
})
