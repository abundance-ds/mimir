import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/app.css'
import WorkbenchShell from '../src/mimir/components/WorkbenchShell.vue'
import WorkbenchSidebar from '../src/mimir/components/WorkbenchSidebar.vue'
import PaneFrame from '../src/mimir/components/PaneFrame.vue'
import ActivityTabs from '../src/mimir/components/ActivityTabs.vue'
import PaneBand from '../src/shared/ui/chrome/PaneBand.vue'
import AppHeader from '../src/editor/components/shell/AppHeader.vue'
import { useWorkbenchStore } from '../src/stores/workbench.js'

// Real shell components with local content. No project or document writes.
window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0, unregisterCallback() {} }
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'parchment'
const app = createApp({
  setup() {
    const store = useWorkbenchStore()
    if (params.get('sidebar') === 'rail') store.setPaneState('sidebar', 'rail')
    if (params.get('activity') === 'rail') store.setPaneState('activity', 'rail')
    if (params.get('editor') === 'rail') store.setPaneState('editor', 'rail')
    const width = ref(innerWidth)
    window.addEventListener('resize', () => { width.value = innerWidth })
    const tabs = ref(Array.from({ length: Number(params.get('tabs') || 3) }, (_, i) => ({ id: `tab-${i}`, title: ['Today', 'Terminal', 'Business graph'][i % 3], icon: 'terminal', unique: true })))
    const activeId = ref('tab-0')
    const fileIndex = ref(0)
    const files = ref(params.has('empty') ? [] : [{ id: 'notes', name: 'Notes.md' }, { id: 'draft', name: 'Draft.md', dirty: true }])
    return () => h(WorkbenchShell, { viewportWidth: width.value, activityTitle: 'Today', editorTitle: 'Notes.md' }, {
      sidebar: ({ collapsed }) => h(WorkbenchSidebar, {
        collapsed, workspaceName: 'Example project',
        tools: [{ id: 'today', title: 'Today', icon: 'calendar' }],
        onToggleCollapse: () => store.togglePane('sidebar'),
      }, { files: () => h('div', { class: 'p-3' }, 'Files') }),
      activity: () => h(PaneFrame, { pane: 'activity', title: 'Activity' }, {
        tabs: () => h(ActivityTabs, {
          tabs: tabs.value, activeId: activeId.value,
          onSelect: id => { activeId.value = id },
          onClose: id => { tabs.value = tabs.value.filter(t => t.id !== id) },
          onNew: () => { tabs.value.push({ id: `tab-${Date.now()}`, title: 'New terminal', icon: 'terminal' }) },
        }),
        default: () => h('div', { class: 'flex h-full flex-col bg-surface' }, [h('div', { class: 'flex-1 p-3' }, 'Main content'), h(PaneBand, { as: 'footer', kind: 'footer' }, 'Saved')]),
      }),
      editor: () => h('div', { class: 'flex h-full flex-col' }, [
        h(AppHeader, { embedded: true, hideSidebar: true, tabs: files.value, activeTab: fileIndex.value, onSelectTab: index => { fileIndex.value = index }, onCloseTab: index => { files.value.splice(index, 1); fileIndex.value = Math.min(fileIndex.value, files.value.length - 1) }, canOpenInBrowser: params.has('html'), onAddTab: () => files.value.push({ id: Date.now(), name: 'Untitled.md' }) }),
        h('div', { class: 'pane-bar' }, 'Editor tools'),
        h('div', { class: 'flex-1 p-3' }, 'Document'),
        h(PaneBand, { as: 'footer', kind: 'footer' }, '12 words'),
      ]),
    })
  },
})
app.use(createPinia()).mount('#app')
