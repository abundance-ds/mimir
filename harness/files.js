// Manual regression surface. Native replies are deterministic fixtures; the
// sidebar, manager, search controller, menus, and theme CSS are production code.
import { createApp, h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import '../src/shared/styles/app.css'
import WorkbenchSidebar from '../src/mimir/components/WorkbenchSidebar.vue'
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
        const matches = indexed.filter(entry => entry.name.toLowerCase().includes(query)).map(entry => ({
          ...entry, line: 4, column: 1, excerpt: `Search notes for ${entry.name}`,
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
    const width = ref(Number(params.get('width')) || 240), collapsed = ref(false), toolsCollapsed = ref(params.has('toolsClosed'))
    const tools = Array.from({ length: Number(params.get('tools')) || 5 }, (_, index) => ({ id: `tool-${index}`, title: `Tool ${index + 1}`, icon: index % 2 ? 'today' : 'graph' }))
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
            workspaceName: 'Project', workspacePath: root, collapsed: collapsed.value, toolsCollapsed: toolsCollapsed.value,
            tools, meetingCapture,
            onToggleCollapse: () => { collapsed.value = !collapsed.value }, onToggleTools: () => { toolsCollapsed.value = !toolsCollapsed.value },
          }, { files: () => h(FilesActivity, { compact: true, active: !collapsed.value, onOpenFile: open }) }),
        ]),
        h('div', { class: 'w-[540px] min-w-0 border-r border-rule' }, [h(FilesActivity, { active: true, onOpenFile: open })]),
        h('div', { class: 'min-w-0 flex-1 p-4 text-ink-3' }, opened.value),
      ]),
    ])
  },
}).use(pinia).mount('#app')
document.documentElement.setAttribute('data-theme', 'dracula')
await files.openWorkspace(root)
await files.toggleDirectory('docs')
await files.toggleDirectory('docs/specs')
