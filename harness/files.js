// Manual regression surface. Native replies are deterministic fixtures; the
// sidebar, manager, search controller, menus, and theme CSS are production code.
import { createApp, h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import '../src/shared/styles/app.css'
import WorkbenchSidebar from '../src/mimir/components/WorkbenchSidebar.vue'
import ActivityTabs from '../src/mimir/components/ActivityTabs.vue'
import FilesActivity from '../src/mimir/activities/FilesActivity.vue'
import { useWorkspaceFilesStore } from '../src/stores/workspaceFiles.js'
import { useSettingsStore } from '../src/stores/settings.js'

const root = '/fixture'
const entries = [
  ['docs', true], ['docs/specs', true], ['docs/specs/alpha-search-notes.md', false],
  ['docs/specs/very-long-sidebar-interaction-specification.md', false],
  ['src', true], ['src/sidebar.vue', false], ['README.md', false],
  ['beta-plan.md', false], ['diagram.svg', false],
].map(([relativePath, isDirectory]) => ({
  path: `${root}/${relativePath}`, relativePath, name: relativePath.split('/').at(-1),
  isDirectory, textReadable: !isDirectory, openBehavior: isDirectory ? 'directory' : 'text',
  mtime: Date.now(), size: isDirectory ? 0 : 1024,
}))
const indexed = entries.filter(entry => !entry.isDirectory)
let tokenId = 0
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'files-check' }, currentWebview: { label: 'files-check' } },
  transformCallback: () => 0,
  unregisterCallback: () => {},
  invoke: async (command, args = {}) => {
    switch (command) {
      case 'file_index_open': return { workspace: root, indexedFiles: indexed.length }
      case 'file_index_files': return indexed
      case 'file_index_filter': return indexed.filter(entry => entry.relativePath.toLowerCase().includes(args.query.toLowerCase())).map(file => ({ file, score: 1 }))
      case 'file_index_begin_search': return { workspaceGeneration: 1, requestGeneration: ++tokenId }
      case 'file_index_cancel_search': return true
      case 'file_index_search': {
        const query = args.request.query.toLowerCase()
        await new Promise(resolve => setTimeout(resolve, query === 'slow' ? 1200 : 150))
        if (query === 'error') throw new Error('Fixture search failure')
        if (query === 'limit') return { matches: [], truncated: true }
        const matches = indexed.filter(entry => entry.name.toLowerCase().includes(query) || (query === 'alpha' && entry.name === 'sidebar.vue')).map(entry => ({
          ...entry, line: 4, column: 1, excerpt: `${query} search notes for ${entry.name}`,
        }))
        return { matches, truncated: false }
      }
      case 'workspace_file_list_directory': return entries.filter(entry => {
        const slash = entry.relativePath.lastIndexOf('/')
        return (slash < 0 ? '' : entry.relativePath.slice(0, slash)) === args.directory
      })
      case 'workspace_file_inspect': return entries.find(entry => entry.path === args.path)
      case 'git_status': return indexed.map(entry => ({ path: entry.relativePath, status: 'modified' }))
      case 'managed_project_status': return { managed: false }
      case 'settings_load': return { settings: { editor: { editorTheme: 'dracula' } } }
      case 'file_index_refresh': return { added: 0, changed: 0, removed: 0 }
      case 'git_review_changes': return []
      default: return null
    }
  },
}
const pinia = createPinia()
setActivePinia(pinia)
const settings = useSettingsStore()
settings.workbenchFileFavorites = { [root]: [{ relativePath: 'beta-plan.md', isDirectory: false }] }
const files = useWorkspaceFilesStore()
createApp({
  setup() {
    const params = new URLSearchParams(location.search)
    const width = ref(Number(params.get('width')) || 240), collapsed = ref(false), filesCollapsed = ref(params.has('filesClosed')), filesHeight = ref(Number(params.get('filesHeight')) || 240)
    const tools = Array.from({ length: Number(params.get('tools')) || 5 }, (_, index) => ({ id: `tool-${index}`, title: `Tool ${index + 1}`, icon: index % 2 ? 'today' : 'graph' }))
    const activities = ref(Array.from({ length: Number(params.get('activities')) || 0 }, (_, index) => ({
      id: `session-${index}`, title: `Review file navigation ${index + 1}`, kind: index % 2 ? 'terminal' : 'agent',
      status: index === 1 ? 'needs-input' : 'working', host: { type: 'pty' },
    })))
    if (params.has('states')) activities.value = [
      ['working', 'Review API', 'working'],
      ['starting', 'Starting agent', 'starting'],
      ['needs-input', 'Approval required', 'needs-input'],
      ['unread', 'New reply', 'idle'],
      ['error', 'API request failed', 'error'],
      ['resuming', 'Resuming session', 'starting'],
      ['idle', 'Terminal', 'idle'],
      ['done', 'Finished review', 'done'],
      ['interrupted', 'Interrupted session', 'interrupted'],
      ['prompt-ready', 'Prompt ready', 'needs-input'],
    ].map(([id, title, status], index) => ({
      id, title, status, kind: id === 'idle' ? 'terminal' : 'agent',
      source: { presetId: id === 'idle' ? 'terminal' : 'codex' }, host: { type: 'pty' },
      updatedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(), unread: id === 'unread',
    }))
    const blockingIds = new Set(params.has('states') ? ['needs-input'] : ['session-1'])
    const restoringIds = new Set(params.has('states') ? ['resuming'] : [])
    const activeActivityId = ref(activities.value[0]?.id || '')
    const selectActivity = id => { activeActivityId.value = id }
    const closeActivity = id => { activities.value = activities.value.filter(tab => tab.id !== id) }
    const reorderActivities = ids => { activities.value = ids.map(id => activities.value.find(tab => tab.id === id)) }
    const renameActivity = ({ id, title }) => { activities.value.find(tab => tab.id === id).title = title }
    const meetingCapture = params.has('recording') ? { id: 'fixture-meeting', lifecycle: 'capturing', micMuted: false } : null
    const opened = ref('Select a file to preview its path.')
    const button = (label, click) => h('button', { class: 'h-7 px-2 border border-rule hover:bg-chrome-mid', onClick: click }, label)
    const open = entry => { opened.value = entry.path }
    return () => h('main', { class: 'flex h-screen flex-col bg-chrome text-ink text-[12px]' }, [
      h('div', { class: 'flex items-center gap-2 border-b border-rule p-2' }, [
        h('strong', 'Files UI check'),
        button('Toggle Sidebar', () => { collapsed.value = !collapsed.value }),
        ...[240, 280, 400].map(value => button(`${value} px`, () => { width.value = value })),
        button('Dark', () => document.documentElement.setAttribute('data-theme', 'dracula')),
        button('Light', () => document.documentElement.setAttribute('data-theme', 'light')),
        h('span', { class: 'text-ink-3' }, 'Try alpha, beta, limit, error, slow.'),
      ]),
      h('div', { class: 'flex min-h-0 flex-1' }, [
        h('div', { class: 'shrink-0 border-r border-rule', style: { width: `${collapsed.value ? 52 : width.value}px` } }, [
          h(WorkbenchSidebar, {
            workspaceName: 'Project', workspacePath: root, collapsed: collapsed.value, filesCollapsed: filesCollapsed.value, filesHeight: filesHeight.value,
            tools, meetingCapture, blockingIds, restoringIds, activities: activities.value, activeActivityId: activeActivityId.value,
            onToggleFiles: () => { filesCollapsed.value = !filesCollapsed.value }, onResizeFiles: value => { filesHeight.value = value },
            onSelectActivity: selectActivity, onCloseActivity: closeActivity, onReorderActivities: reorderActivities, onRenameActivity: renameActivity,
            onToggleCollapse: () => { collapsed.value = !collapsed.value },
          }, { files: ({ collapse }) => h(FilesActivity, { compact: true, collapsible: true, onCollapse: collapse, active: !collapsed.value && !filesCollapsed.value, onOpenFile: open }) }),
        ]),
        h('div', { class: 'flex w-[540px] min-w-0 flex-col border-r border-rule' }, [
          h('div', { class: 'pane-header' }, [h(ActivityTabs, { tabs: activities.value, blockingIds, restoringIds, activeId: activeActivityId.value, onSelect: selectActivity, onClose: closeActivity, onReorder: reorderActivities, onRename: renameActivity })]),
          h('div', { class: 'min-h-0 flex-1' }, [h(FilesActivity, { active: true, onOpenFile: open })]),
        ]),
        h('div', { class: 'min-w-0 flex-1 p-4 text-ink-3' }, opened.value),
      ]),
    ])
  },
}).use(pinia).mount('#app')
document.documentElement.setAttribute('data-theme', 'dracula')
await files.openWorkspace(root)
await files.toggleDirectory('docs')
await files.toggleDirectory('docs/specs')
