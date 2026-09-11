import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/app.css'
import WorkbenchShell from '../src/mimir/components/WorkbenchShell.vue'
import WorkbenchSidebar from '../src/mimir/components/WorkbenchSidebar.vue'
import PaneFrame from '../src/mimir/components/PaneFrame.vue'
import ActivityTabs from '../src/mimir/components/ActivityTabs.vue'
import ActivityTabMenu from '../src/mimir/components/ActivityTabMenu.vue'
import { IconPlus, IconX } from '@tabler/icons-vue'
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
    if (params.has('sidebarWidth')) store.setPaneWidth('sidebar', Number(params.get('sidebarWidth')))
    if (params.get('sidebar') === 'rail') store.setPaneState('sidebar', 'rail')
    if (params.get('activity') === 'rail') store.setPaneState('activity', 'rail')
    if (params.get('editor') === 'rail') store.setPaneState('editor', 'rail')
    const width = ref(innerWidth)
    window.addEventListener('resize', () => { width.value = innerWidth })
    const tabs = ref(Array.from({ length: Number(params.get('tabs') || 3) }, (_, i) => ({ id: `tab-${i}`, title: ['Today', 'Terminal', 'Business graph'][i % 3], icon: 'terminal', unique: true })))
    const activeId = ref('tab-0')
    const showTabs = ref(!params.has('vertical'))
    const select = id => { activeId.value = id }
    const close = id => { tabs.value = tabs.value.filter(tab => tab.id !== id); if (activeId.value === id) activeId.value = tabs.value[0]?.id || '' }
    const add = () => { const id = `tab-${Date.now()}`; tabs.value.push({ id, title: 'New terminal', icon: 'terminal' }); activeId.value = id }
    const fileIndex = ref(0)
    const files = ref(params.has('empty') ? [] : [{ id: 'notes', name: 'Notes.md' }, { id: 'draft', name: 'Draft.md', dirty: true }])
    return () => h(WorkbenchShell, { viewportWidth: width.value, activityTitle: 'Today', editorTitle: 'Notes.md' }, {
      sidebar: ({ collapsed }) => h(WorkbenchSidebar, {
        collapsed, workspaceName: 'Example project',
        tools: [{ id: 'today', title: 'Today', icon: 'calendar' }],
        onToggleCollapse: () => store.togglePane('sidebar'),
      }, { files: () => h('div', { class: 'p-3' }, 'Files') }),
      activity: () => h(PaneFrame, { pane: 'activity', title: tabs.value.find(tab => tab.id === activeId.value)?.title || 'Activity', meta: 'Working' }, {
        ...(showTabs.value ? {
          tabs: () => h(ActivityTabs, { tabs: tabs.value, activeId: activeId.value, onSelect: select, onClose: close, onNew: add }),
        } : {
          leading: () => h(ActivityTabMenu, { label: 'Open views', tabs: tabs.value, activeId: activeId.value, onSelect: select, onNew: add }),
          actions: () => [
            h('button', { 'data-new-main-tab': '', class: 'pane-icon-button', 'aria-label': 'New Activity', onClick: add }, h(IconPlus, { size: 15 })),
            activeId.value && h('button', { 'data-close-main-view': '', class: 'pane-icon-button', 'aria-label': 'Close current view', onClick: () => close(activeId.value) }, h(IconX, { size: 13 })),
          ],
        }),
        default: () => h('div', { class: 'flex h-full flex-col bg-surface' }, [
          h('div', { 'data-main-content': '', class: 'flex-1 p-3' }, 'Main content'),
          h(PaneBand, { as: 'footer', kind: 'footer' }, () => h('button', { 'data-harness-toggle-tabs': '', onClick: () => { showTabs.value = !showTabs.value } }, 'Toggle main tabs')),
        ]),
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
