import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'

vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../services/ai/chatTransport', () => ({ createShouldersChatTransport: vi.fn() }))
vi.mock('../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('../services/ai/modelControls', () => ({
  controlForModel: () => ({ id: '', label: '', options: [] }),
  defaultControlId: () => '',
  modelDisplayName: () => '',
  modelMenuItems: () => [],
  normalizeModelId: (id) => id || null,
  providerConfigured: () => false,
  resolveConcreteModel: () => 'test',
  resolveDefaultModel: () => ({ id: 'test-model' }),
}))
vi.mock('../stores/panel/persistence', () => ({
  schedulePersist: vi.fn(),
  loadInitialState: vi.fn(),
}))

// --- Editor shell ---
import AppHeader from '../editor/components/shell/AppHeader.vue'
// --- Editor sidebar ---
import SidebarOutline from '../editor/components/sidebar/SidebarOutline.vue'
import SidebarRefs from '../editor/components/sidebar/SidebarRefs.vue'
import SidebarHistory from '../editor/components/sidebar/SidebarHistory.vue'
import SidebarNotes from '../editor/components/sidebar/SidebarNotes.vue'
import CommentCard from '../editor/components/sidebar/CommentCard.vue'

// --- Editor workspace ---
import PreviewPane from '../editor/components/workspace/PreviewPane.vue'
import InlineAI from '../editor/components/workspace/InlineAI.vue'
import ProposalActionBar from '../panel/components/ProposalActionBar.vue'

// --- Panel ---
import PanelHeader from '../panel/components/PanelHeader.vue'
import SidebarRow from '../panel/components/SidebarRow.vue'
import ModelPicker from '../panel/components/ModelPicker.vue'
import ControlPicker from '../panel/components/ControlPicker.vue'
import ToolCallBlock from '../panel/components/ToolCallBlock.vue'
import ProjectContextMenu from '../panel/components/ProjectContextMenu.vue'
import SessionContextMenu from '../panel/components/SessionContextMenu.vue'
import AddProjectDialog from '../panel/components/AddProjectDialog.vue'
import TerminalPanel from '../panel/components/TerminalPanel.vue'
import AppSetup from '../panel/components/AppSetup.vue'
import AppStandard from '../panel/components/AppStandard.vue'
import AppCustom from '../panel/components/AppCustom.vue'

// --- Board ---
import BoardHeader from '../panel/components/board/BoardHeader.vue'
import KanbanCard from '../panel/components/board/KanbanCard.vue'
import KnowledgeCard from '../panel/components/board/KnowledgeCard.vue'

// --- Shared ---
import AuditSection from '../shared/ui/settings/AuditSection.vue'

describe('Smoke: component mounts', () => {
  // --- Editor shell ---
  it('AppHeader', () => {
    const w = shallowMount(AppHeader, {
      props: { sidebarOpen: false, showAppMenus: false, recentFiles: [], canSave: false, hasSelection: false, references: [], tabs: [] },
    })
    expect(w.exists()).toBe(true)
  })

  // --- Editor sidebar ---
  it('SidebarOutline', () => {
    const w = shallowMount(SidebarOutline, {
      props: { outline: [], cursorLine: 1 },
    })
    expect(w.exists()).toBe(true)
  })

  it('SidebarRefs', () => {
    const w = shallowMount(SidebarRefs, {
      props: { references: [] },
    })
    expect(w.exists()).toBe(true)
  })

  it('SidebarHistory', () => {
    const w = shallowMount(SidebarHistory)
    expect(w.exists()).toBe(true)
  })

  it('SidebarNotes', () => {
    const { ref } = require('vue')
    const w = shallowMount(SidebarNotes, {
      global: {
        provide: {
          editorSurfaceRef: ref(null),
          editorScrollInfo: ref({ scrollTop: 0 }),
        },
      },
    })
    expect(w.exists()).toBe(true)
  })

  it('CommentCard', () => {
    const w = shallowMount(CommentCard, {
      props: {
        comment: { id: '1', text: 'test', author: 'me', replies: [], status: 'active' },
        active: false,
        expanded: false,
      },
    })
    expect(w.exists()).toBe(true)
  })

  // --- Editor workspace ---
  it('PreviewPane', () => {
    const w = shallowMount(PreviewPane, { props: { content: '# Hello' } })
    expect(w.exists()).toBe(true)
  })

  it('InlineAI', () => {
    const w = shallowMount(InlineAI, {
      props: { selection: { from: 0, to: 5, text: 'hello' }, documentId: 'doc-1' },
    })
    expect(w.exists()).toBe(true)
  })

  it('ProposalActionBar', () => {
    const w = shallowMount(ProposalActionBar, {
      props: {
        proposals: [
          { id: '1', path: 'file.md', status: 'pending', targetText: 'a\nb', replacement: 'c\nd\ne' },
        ],
      },
    })
    expect(w.exists()).toBe(true)
  })

  // --- Panel ---
  it('PanelHeader', () => {
    const w = shallowMount(PanelHeader, {
      props: { sidebarOpen: true, sidebarWidth: 256 },
    })
    expect(w.exists()).toBe(true)
  })

  it('SidebarRow', () => {
    const w = shallowMount(SidebarRow, {
      props: { label: 'Test Row' },
    })
    expect(w.exists()).toBe(true)
  })

  it('ModelPicker', () => {
    const w = shallowMount(ModelPicker, {
      props: { modelId: 'test', models: [], disabled: false },
    })
    expect(w.exists()).toBe(true)
  })

  it('ControlPicker', () => {
    const w = shallowMount(ControlPicker, {
      props: { controlId: 'test', label: 'Control', options: [], disabled: false },
    })
    expect(w.exists()).toBe(true)
  })

  it('ToolCallBlock', () => {
    const w = shallowMount(ToolCallBlock, {
      props: {
        part: { toolInvocation: { toolName: 'test', args: {}, state: 'result' } },
      },
    })
    expect(w.exists()).toBe(true)
  })

  it('ProjectContextMenu', () => {
    const w = shallowMount(ProjectContextMenu, {
      props: { x: 100, y: 100, hasFolder: false, system: false },
    })
    expect(w.exists()).toBe(true)
  })

  it('SessionContextMenu', () => {
    const w = shallowMount(SessionContextMenu, {
      props: { x: 100, y: 100, pinned: false },
    })
    expect(w.exists()).toBe(true)
  })

  it('AddProjectDialog', () => {
    const w = shallowMount(AddProjectDialog, {
      props: { mode: 'new' },
    })
    expect(w.exists()).toBe(true)
  })



  it('TerminalPanel', () => {
    const w = shallowMount(TerminalPanel, {
      props: { visible: false },
    })
    expect(w.exists()).toBe(true)
  })

  // --- App components ---
  it('AppSetup', () => {
    const w = shallowMount(AppSetup, {
      props: { session: { id: 's1', appId: 'test' }, app: { name: 'Test', setup: { fields: [] } } },
    })
    expect(w.exists()).toBe(true)
  })

  it('AppStandard', () => {
    const w = shallowMount(AppStandard, {
      props: { session: { id: 's1', appStatus: 'running', appEvents: [], usage: {} }, app: { name: 'Test' } },
    })
    expect(w.exists()).toBe(true)
  })

  it('AppCustom', () => {
    const w = shallowMount(AppCustom, {
      props: { session: { id: 's1', appId: 'test', projectId: 'p1', appName: 'Test' }, app: { name: 'Test' } },
    })
    expect(w.exists()).toBe(true)
  })

  // --- Board ---
  it('BoardHeader', () => {
    const w = shallowMount(BoardHeader, {
      props: { project: { name: 'Test', workspacePath: '/test' } },
    })
    expect(w.exists()).toBe(true)
  })

  it('KanbanCard', () => {
    const w = shallowMount(KanbanCard, {
      props: { entry: { id: 'i1', meta: { type: 'issue', title: 'Test', status: 'backlog', priority: 'normal', tags: [] } } },
    })
    expect(w.exists()).toBe(true)
  })

  it('KnowledgeCard', () => {
    const w = shallowMount(KnowledgeCard, {
      props: { entry: { id: 'k1', meta: { type: 'knowledge', title: 'Knowledge entry', tags: [] }, body: 'content' } },
    })
    expect(w.exists()).toBe(true)
  })

  // --- Shared ---
  it('AuditSection', () => {
    const w = shallowMount(AuditSection)
    expect(w.exists()).toBe(true)
  })
})
