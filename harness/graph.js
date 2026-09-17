// Production Graph table with local fixtures. This harness never reads or writes Graph files.
import { computed, createApp, h, ref } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import GraphEntries from '../src/mimir/apps/business-graph/GraphEntries.vue'
import GraphAppHeader from '../src/mimir/apps/business-graph/GraphAppHeader.vue'
import { entryProjects, NO_PROJECT } from '../src/mimir/apps/business-graph/graphEntryMetadata.js'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'parchment'
// Offset and clip the pane to catch popovers that only work in a full-window table.
if (params.has('pane')) {
  const left = Math.max(0, Number(params.get('offset') ?? 260) || 0)
  Object.assign(document.querySelector('#app').style, {
    width: `${Math.min(Number(params.get('pane')) || 500, innerWidth - left)}px`,
    margin: `64px 0 0 ${left}px`, height: 'calc(100vh - 96px)',
  })
}
const nodes = [
  ['release', 'note', 'Release checklist', '2026-09-17', '2026-08-21', 'atlas'],
  ['export', 'decision', 'Use CSV for time sheet exports', '2026-09-17', '2026-09-02', 'atlas'],
  ['review', 'meeting', 'September project review', '2026-09-16', '2026-09-10', 'atlas'],
  ['atlas', 'project', 'Atlas', '2026-09-14', '2026-06-02', ''],
  ['protocol', 'resource', 'Study protocol and supporting reference material', '2026-09-12', '2026-07-11', 'atlas'],
  ['anna', 'person', 'Anna Berg', '2026-08-29', '2026-05-01', ''],
  ['report', 'issue', 'Review the evidence report', '2026-08-21', '2026-08-12', 'atlas'],
  ['notes', 'note', 'Research notes', '2026-08-16', '2026-08-16', 'beta'],
  ['beta', 'project', 'Beta', '2026-08-14', '2026-07-02', ''],
  ['retired', 'note', 'Imported note without dates', '', '', ''],
].map(([id, kind, title, updatedAt, createdAt, projectId]) => ({ id, kind, title, updatedAt, createdAt, projectId }))
const projects = nodes.filter(node => node.kind === 'project')
if (params.has('many')) for (let i = 0; i < 250; i++) nodes.push({ id: `extra-${i}`, kind: 'note', title: `Research note ${String(i).padStart(3, '0')}`, projectId: 'atlas', updatedAt: '2026-01-01' })

createApp({
  setup() {
    const browseOrder = ref({ sortBy: 'updated', direction: 'desc' })
    const searchOrder = ref({ sortBy: 'relevance', direction: 'desc' })
    const kinds = ref([]), projectIds = ref([]), search = ref(''), selected = ref(''), changes = ref(false)
    const entries = ref(nodes)
    const order = computed(() => search.value ? searchOrder.value : browseOrder.value)
    const sort = value => {
      const target = search.value ? searchOrder : browseOrder
      target.value = { sortBy: value.sortBy, direction: value.direction || (['title', 'kind', 'project'].includes(value.sortBy) ? 'asc' : 'desc') }
    }
    const visible = computed(() => entries.value.filter(node => {
      const memberships = entryProjects(node, projects).map(project => project.id)
      return (!kinds.value.length || kinds.value.includes(node.kind))
        && (!projectIds.value.length || (memberships.length ? memberships.some(id => projectIds.value.includes(id)) : projectIds.value.includes(NO_PROJECT)))
        && node.title.toLowerCase().includes(search.value.toLowerCase())
    }).sort((a, b) => {
      const { sortBy, direction } = order.value
      const date = ['updated', 'created'].includes(sortBy)
      const field = date ? `${sortBy}At` : sortBy
      const left = sortBy === 'project' ? entryProjects(a, projects)[0]?.title : a[field]
      const right = sortBy === 'project' ? entryProjects(b, projects)[0]?.title : b[field]
      if (sortBy === 'relevance') return Number(b.title.toLowerCase() === search.value.toLowerCase()) - Number(a.title.toLowerCase() === search.value.toLowerCase()) || a.title.localeCompare(b.title)
      if ((date || sortBy === 'project') && (!left || !right)) return left ? -1 : right ? 1 : a.title.localeCompare(b.title)
      return String(left).localeCompare(String(right)) * (direction === 'asc' ? 1 : -1) || a.title.localeCompare(b.title)
    }))
    window.graphPreview = { prepend: () => { entries.value = [{ id: 'new', kind: 'note', title: 'New entry', updatedAt: '2030-01-01' }, ...entries.value] } }
    return () => [
      h(GraphAppHeader, {
        sections: [{ id: 'work', label: 'Work' }, { id: 'all', label: 'Graph' }], section: 'all', sectionLabel: 'Graph',
        changesActive: changes.value && !search.value,
        onSetSection: () => { changes.value = false },
        onShowChanges: () => { changes.value = true; search.value = '' },
        scopes: [{ id: 'team', kind: 'team', root: '/preview' }], activeScopeIds: ['team'],
        searchValue: search.value, searchQuery: search.value, resultCount: visible.value.length,
        'onUpdate:searchValue': value => { search.value = value; searchOrder.value = { sortBy: 'relevance', direction: 'desc' } },
        onClearSearch: () => { search.value = '' },
      }),
      changes.value && !search.value ? h('p', { style: 'padding:16px;color:var(--color-ink-3)' }, 'Changes preview') : h(GraphEntries, {
        nodes: visible.value, availableKinds: [...new Set(nodes.map(node => node.kind))], projects, currentProjectId: 'atlas', kinds: kinds.value, projectIds: projectIds.value,
        sortBy: order.value.sortBy, direction: order.value.direction, searchActive: Boolean(search.value),
        contextKey: JSON.stringify([search.value, order.value, kinds.value, projectIds.value]),
        'onUpdate:kinds': value => { kinds.value = value }, 'onUpdate:projectIds': value => { projectIds.value = value },
        onSort: sort, onOpen: id => { selected.value = id },
      }),
      selected.value ? h('output', { style: 'padding:8px;color:var(--color-ink);' }, `Opened: ${entries.value.find(node => node.id === selected.value)?.title}`) : null,
    ]
  },
}).mount('#app')
