import { createApp, h, onUnmounted, ref } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import BusinessGraphApp from '../src/mimir/apps/BusinessGraphApp.vue'
import GraphMarkdownEditor from '../src/mimir/apps/business-graph/GraphMarkdownEditor.vue'
import WorkbenchShell from '../src/mimir/components/WorkbenchShell.vue'
import WorkbenchSidebar from '../src/mimir/components/WorkbenchSidebar.vue'
import PaneFrame from '../src/mimir/components/PaneFrame.vue'
import AppHeader from '../src/editor/components/shell/AppHeader.vue'
import PaneBand from '../src/shared/ui/chrome/PaneBand.vue'
import { useWorkbenchStore } from '../src/stores/workbench.js'
import { useBusinessGraphStore } from '../src/stores/businessGraph.js'
import { loadWorkspaceConfig } from '../src/services/workspaceConfig.js'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') || 'parchment'
document.documentElement.setAttribute('data-theme', theme)
// The settings store applies its configured theme on load; seed it.
localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({ editorTheme: theme }))

const iso = offset => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}
const stamp = (h, m) => {
  const date = new Date()
  date.setHours(h, m, 0, 0)
  return date.toISOString()
}

const scopes = [
  { id: 'private:local', kind: 'private', root: '/Users/waqr/.mimir/graph/private' },
  { id: 'project:atlas', kind: 'project', root: '/work/atlas' },
  { id: 'team:main', kind: 'team', root: '/team/graph' },
]
const mkIssue = (id, title, status, extra = {}) => ({
  id, kind: 'issue', title, status, summary: '',
  tags: [], projectId: 'project-atlas', scopeId: 'project:atlas',
  sourceRevision: 'r1', updatedAt: stamp(8, 30), relations: [], ...extra,
})
const summaries = [
  mkIssue('issue-map', 'Build evidence map for the value dossier', 'in-progress', { priority: 'high', dueDate: iso(-2), deliverables: ['outputs/evidence-map.md'] }),
  mkIssue('issue-comparator', 'Confirm comparator set with the client', 'waiting', { priority: 'urgent', waitingFor: 'Sanitized client confirmation' }),
  mkIssue('issue-abstracts', 'Screen 240 abstracts against PICO', 'in-progress', { priority: 'high' }),
  mkIssue('issue-walkthrough', 'Book the October client walkthrough', 'plan', { priority: 'normal', dueDate: iso(9) }),
  mkIssue('issue-objections', 'Collect payer objections from the advisory board', 'plan', { priority: 'normal' }),
  mkIssue('issue-registry', 'Clean the trial registry extract', 'backlog', { priority: 'low', dueDate: iso(16) }),
  mkIssue('issue-qc', 'QC the extraction sheet', 'review', { priority: 'normal', dueDate: iso(1) }),
  mkIssue('issue-kickoff', 'File kickoff notes', 'done', { priority: 'normal' }),
  {
    id: 'project-atlas', kind: 'project', title: params.get('projectName') || 'Atlas', summary: 'Global value evidence strategy',
    slug: 'atlas', scopeId: 'team:main', sourceRevision: 'r2', updatedAt: stamp(9, 5),
    relations: [{ relation: 'for_company', target: 'company-acme' }],
  },
  {
    id: 'person-alex', kind: 'person', title: 'Alex Researcher', summary: 'HEOR lead at Acme',
    scopeId: 'team:main', sourceRevision: 'r3', updatedAt: stamp(7, 12), relations: [],
  },
  {
    id: 'company-acme', kind: 'company', title: 'Acme', summary: 'Client',
    scopeId: 'team:main', sourceRevision: 'r4', updatedAt: stamp(7, 1), relations: [],
  },
  {
    id: 'dec-cohort', kind: 'decision', title: 'Use the matched cohort', summary: 'Comparator decision',
    scopeId: 'project:atlas', sourceRevision: 'r5', updatedAt: stamp(8, 1),
    relations: [{ relation: 'part_of', target: 'project-atlas' }],
  },
]
// Fictional Pipeline fixtures: companies with sales properties, sales notes,
// and a connections export. No real company or person appears here.
const company = (id, title, extra = {}) => ({
  id, kind: 'company', title, summary: '', tags: [], scopeId: 'team:main',
  sourceRevision: `${id}-r1`, updatedAt: stamp(7, 30), relations: [], ...extra,
})
const salesNote = (id, title, tag, summary) => ({
  id, kind: 'note', title, summary, tags: [tag], scopeId: 'team:main',
  sourceRevision: `${id}-r1`, updatedAt: stamp(7, 40), relations: [],
})
summaries.push(
  company('company-northwind', 'Northwind Health Economics'),
  company('company-contoso', 'Contoso Therapeutics'),
  company('company-fabrikam', 'Fabrikam Capital'),
  company('company-tailspin', 'Tailspin Outcomes'),
  salesNote('trigger-new-hire', 'New head of HEOR hired', 'sales-trigger', 'A company names a new HEOR lead who will review suppliers.'),
  salesNote('trigger-launch', 'Launch planned in a new market', 'sales-trigger', 'A product launch needs a value dossier within a year.'),
  salesNote('trigger-funding', 'Funding round closed', 'sales-trigger', 'A firm closes a round and plans to grow its services.'),
  salesNote('play-warm-intro', 'Warm introduction through a shared connection', 'sales-play', 'Ask a shared connection for an introduction.'),
  salesNote('play-webinar', 'Joint method webinar', 'sales-play', 'Run a short webinar with a partner firm.'),
)
const properties = {
  'company-acme': { roles: ['client'] },
  'company-northwind': {
    companyType: 'HEOR consultancy', hqCity: 'London', hqCountry: 'United Kingdom', pipelineStage: 'In conversation',
    pipelineTrigger: 'trigger-new-hire', pipelineTriggerNote: 'Their new lead wants outside model support this quarter.',
    pipelinePlay: 'play-warm-intro', pipelineNextStep: 'Send the case study', connectionAliases: ['Northwind HE'],
  },
  'company-contoso': {
    companyType: 'Pharma', hqCity: 'Basel', hqCountry: 'Switzerland', pipelineStage: 'Target',
    pipelineTrigger: 'trigger-launch', pipelineNextStep: 'Find the market access lead',
  },
  'company-fabrikam': {
    companyType: 'Private equity', hqCity: 'New York', hqCountry: 'United States', pipelineStage: 'Contacted',
    pipelineTrigger: 'trigger-funding', portfolio: 'Northwind Health Economics; Tailspin Outcomes',
  },
  'company-tailspin': { companyType: 'HEOR consultancy', hqCity: 'Leeds', hqCountry: 'United Kingdom' },
  'trigger-new-hire': {
    triggerCategory: 'People', triggerRating: 'Strong', triggerFor: 'Both', triggerSpot: 'Job change posts',
    triggerWho: 'The new lead', triggerOpener: 'Congratulations on the new role. We help teams in the first 90 days.',
    triggerWhy: 'New leads review suppliers early.',
  },
  'trigger-launch': {
    triggerCategory: 'Market', triggerRating: 'Medium', triggerFor: 'Pharma', triggerSpot: 'Company news',
    triggerWho: 'Market access lead', triggerWhy: 'A launch needs evidence on a fixed date.',
  },
  'trigger-funding': { triggerCategory: 'Money', triggerRating: 'Watch', triggerFor: 'HEOR consultancies', triggerSpot: 'Investor news' },
  'play-warm-intro': {
    playFor: 'Both', playVerdict: 'Working', playTriggers: ['trigger-new-hire'],
    playSteps: ['Find a shared connection', 'Ask for a short introduction', 'Offer a 20 minute call'],
    playLearned: 'A short, specific request gets more replies.',
  },
  'play-webinar': { playFor: 'HEOR consultancies', playVerdict: 'Untested', playTriggers: ['trigger-funding', 'Missing trigger'] },
}
const connectionsCsv = [
  'Notes:',
  '"This is a fictional connections export for the harness."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On,Messaged,Previous communication summary',
  'Ada,Example,https://www.linkedin.com/in/ada-example,ada@example.com,Northwind Health Economics Ltd,Head of Market Access,01 Mar 2025,Yes,"Talked about a cost model, in March."',
  'Ben,Sample,https://www.linkedin.com/in/ben-sample,,Northwind HE,Senior Health Economist,12 Jan 2024,No,',
  'Cara,Placeholder,https://www.linkedin.com/in/cara-placeholder,,Contoso Therapeutics AG,Associate Director HEOR,05 May 2023,No,No matching messages',
  'Dan,Demo,https://www.linkedin.com/in/dan-demo,,University of Exampleton,Research Fellow,20 Feb 2022,No,',
  'Eve,Fixture,https://www.linkedin.com/in/eve-fixture,,Wingtip Analytics,Consultant,11 Nov 2024,Yes,"Asked about a joint webinar."',
  'Finn,Test,https://www.linkedin.com/in/finn-test,,"Wingtip Analytics, Inc.",Procurement Manager,02 Jun 2025,No,',
  'Gus,Mock,https://www.linkedin.com/in/gus-mock,,Fabrikam Capital,Partner,15 Aug 2021,Yes,',
  'Hana,Sample,https://www.linkedin.com/in/hana-sample,,Litware Pharma,Medical Science Liaison,09 Sep 2023,No,',
  ',,,,,,,,',
].join('\n')

const events = [
  {
    id: 'e1', eventType: 'deliverable-added', action: 'issues.add_deliverable',
    timestamp: stamp(9, 41), graphRevision: 44, nodeId: 'issue-map', nodeKind: 'issue',
    title: 'Build evidence map', scopeId: 'project:atlas',
    summary: 'Added deliverable · Build evidence map for the value dossier',
    actor: { kind: 'agent', id: 'codex', label: 'Codex', initials: 'CX' },
    changes: [{ field: 'deliverables', before: [], after: ['outputs/evidence-map.md'] }],
    data: { deliverable: { path: 'outputs/evidence-map.md', label: 'Evidence map draft' } },
  },
  {
    id: 'e2', eventType: 'status-changed', action: 'issues.move',
    timestamp: stamp(9, 12), graphRevision: 43, nodeId: 'issue-map', nodeKind: 'issue',
    title: 'Build evidence map', scopeId: 'project:atlas',
    summary: 'Plan → in progress · Build evidence map for the value dossier',
    actor: { kind: 'human', id: 'local-human', label: 'You', initials: 'ME' },
    changes: [{ field: 'status', before: 'plan', after: 'in-progress' }], data: {},
  },
  {
    id: 'e3', eventType: 'decision-recorded', action: 'projects.record_decision',
    timestamp: stamp(8, 52), graphRevision: 42, nodeId: 'dec-cohort', nodeKind: 'decision',
    title: 'Use the matched cohort', scopeId: 'project:atlas',
    summary: 'Recorded decision · Use the matched cohort',
    actor: { kind: 'agent', id: 'pi', label: 'Pi', initials: 'PI' },
    changes: [], data: {},
  },
]

const fullNode = id => {
  const summary = summaries.find(item => item.id === id)
  return {
    ...summary,
    createdAt: new Date(Date.now() - (30 * 86_400_000)).toISOString(),
    body: id === 'person-alex' ? 'Primary contact for extraction QC.' : 'Working note.',
    properties: id === 'person-alex'
      ? { role: 'HEOR lead', email: 'alex@acme.example', phone: '+49 30 555 010' }
      : { ...(properties[id] || {}) },
    relations: id === 'person-alex' ? [{ relation: 'works_at', target: 'company-acme' }] : (summary?.relations || []),
    provenance: { scopeId: summary?.scopeId || 'project:atlas', sourceRevision: summary?.sourceRevision || 'r9', sourcePath: `/work/atlas/${id}.md` },
  }
}

function filterNodes(query = {}) {
  const anchor = summaries.find(node => node.id === query.relatedTo)
  const related = new Set(anchor ? [anchor.id, ...(anchor.relations || []).map(edge => edge.target)] : [])
  if (anchor) summaries.forEach(node => {
    if (node.projectId === anchor.id || node.relations?.some(edge => edge.target === anchor.id)) related.add(node.id)
  })
  return summaries.filter(node => (!query.scopeIds?.length || query.scopeIds.includes(node.scopeId))
    && (!query.kinds?.length || query.kinds.includes(node.kind))
    && (!query.tags?.length || query.tags.every(tag => node.tags?.includes(tag)))
    && (!query.relatedTo || related.has(node.id)))
}

window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    switch (cmd) {
      case 'graph_open':
        return { scopes, nodeCount: summaries.length, diagnosticCount: 0, graphRevision: 44 }
      case 'workspace_config_load':
        return { id: 'workspace-atlas', project: params.has('noProject') ? '' : 'project-atlas', graphScope: 'team' }
      case 'graph_query': {
        const items = filterNodes(args?.query)
        return { items, total: items.length, graphRevision: 44 }
      }
      case 'graph_diagnostics':
        return []
      case 'graph_events':
        return { items: events, total: events.length, offset: 0, limit: 500 }
      case 'graph_search': {
        const query = String(args?.query || '').toLowerCase()
        return filterNodes(args)
          .filter(node => (
            node.title.toLowerCase().includes(query)
            || node.id.includes(query)
            || (node.summary || '').toLowerCase().includes(query)
          ))
          .map(node => ({ node }))
      }
      case 'graph_get':
        return fullNode(args?.id)
      case 'graph_update': {
        const patch = args?.patch || {}
        const summary = summaries.find(item => item.id === patch.id)
        if (!summary) throw new Error('Graph node not found.')
        if (patch.expectedRevision && patch.expectedRevision !== summary.sourceRevision) throw new Error('Source changed. Reload and try again.')
        properties[patch.id] = { ...(properties[patch.id] || {}), ...(patch.setProperties || {}) }
        for (const key of patch.removeProperties || []) delete properties[patch.id][key]
        summary.sourceRevision = `${patch.id}-r${Date.now()}`
        return fullNode(patch.id)
      }
      case 'graph_create': {
        const create = args?.create || {}
        const id = `${create.kind}-${Date.now()}`
        summaries.push({ id, kind: create.kind, title: create.title, summary: create.summary || '', tags: create.tags || [],
          scopeId: create.scopeId || 'team:main', sourceRevision: `${id}-r1`, updatedAt: new Date().toISOString(), relations: [] })
        properties[id] = { ...(create.properties || {}) }
        return fullNode(id)
      }
      case 'read_text_file':
        if (String(args?.path || '').endsWith('/resources/connections.csv') && !params.has('noConnections')) return { content: connectionsCsv }
        throw new Error('No such file or directory (os error 2)')
      case 'graph_neighbors': {
        if (args?.id !== 'issue-map') return []
        return [
          {
            relation: 'part_of',
            direction: 'outgoing',
            node: summaries.find(node => node.id === 'project-atlas'),
          },
          {
            relation: 'blocked_by',
            direction: 'incoming',
            node: summaries.find(node => node.id === 'issue-comparator'),
          },
        ]
      }
      case 'graph_context':
        return { graphRevision: 44, markdown: '# Business graph context\n\nBounded snapshot.' }
      case 'settings_load': {
        // Seed the saved view so hydration keeps ?section= and ?view=.
        const section = params.get('section') || 'all'
        const view = params.get('view')
        return { settings: { editor: { editorTheme: theme, businessGraphViewState: {
          section, sectionViews: view ? { [section]: view } : {},
        } } } }
      }
      case 'settings_save':
      case 'settings_save_editor':
      case 'settings_changed':
        return null
      default:
        return null
    }
  },
  transformCallback: () => 0,
  unregisterCallback: () => {},
}

const pinia = createPinia()
const app = createApp({
  setup() {
    const graphApp = () => h(BusinessGraphApp, {
      workspacePath: '/work/atlas',
      active: true,
    })
    if (!params.has('workbench')) return graphApp

    // Production panes around the Graph fixture, to review overlays in context.
    const workbench = useWorkbenchStore()
    workbench.setPaneWidth('sidebar', 220)
    workbench.setPaneWidth('editor', 400)
    const width = ref(innerWidth)
    const resize = () => { width.value = innerWidth }
    window.addEventListener('resize', resize)
    onUnmounted(() => window.removeEventListener('resize', resize))
    const notes = ref('# Evidence plan\n\n## This week\n\n- Confirm the comparator set\n- Review the utility inputs\n- Complete extraction QC\n\n## Review notes\n\nKeep the source links with each estimate. Record assumptions before the model review.')
    return () => h(WorkbenchShell, { viewportWidth: width.value, activityTitle: 'Business graph', editorTitle: 'Notes.md' }, {
      sidebar: ({ collapsed }) => h(WorkbenchSidebar, {
        collapsed, workspaceName: 'Atlas', workspacePath: '/work/atlas',
        activeToolId: 'graph',
        tools: [{ id: 'today', title: 'Today', icon: 'calendar' }, { id: 'graph', title: 'Business graph', icon: 'graph' }, { id: 'scribe', title: 'Scribe', icon: 'microphone' }],
        onToggleCollapse: () => workbench.togglePane('sidebar'),
      }),
      activity: () => h(PaneFrame, { pane: 'activity', title: 'Business graph' }, { default: graphApp }),
      editor: () => h('div', { class: 'flex h-full min-h-0 flex-col bg-surface' }, [
        h(AppHeader, { embedded: true, hideSidebar: true, tabs: [{ id: 'notes', name: 'Notes.md' }], activeTab: 0 }),
        h('div', { class: 'min-h-0 flex-1 overflow-y-auto p-5' }, [
          h(GraphMarkdownEditor, { canvasStyle: true, framed: false, modelValue: notes.value, 'onUpdate:modelValue': value => { notes.value = value } }),
        ]),
        h(PaneBand, { as: 'footer', kind: 'footer' }, () => 'Markdown'),
      ]),
    })
  },
})
app.use(pinia)
const graph = useBusinessGraphStore(pinia)
await loadWorkspaceConfig('/work/atlas')
await graph.start('/work/atlas')
app.mount('#app')
graph.setSection(params.get('section') || 'all')
if (params.get('view')) graph.setView(params.get('view'))

const action = params.get('do')
if (action) {
  setTimeout(async () => {
    if (action === 'search') {
      const input = document.querySelector('[data-graph-search]')
      input?.focus()
      if (input) {
        input.value = 'alex'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    if (action === 'expand') {
      document.querySelector('[data-pipeline-row-button]')?.click()
    }
    if (action === 'board') {
      document.querySelector('[data-graph-section="work"]')?.click()
    }
    if (action === 'peek') {
      document.querySelector('[data-graph-section="work"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 400))
      document.querySelector('[data-board-card="issue-map"]')?.click()
    }
  }, 900)
}
