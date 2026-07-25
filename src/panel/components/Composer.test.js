import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { useChatStore } from '../../stores/panel/chat.js'

// Mock all transitive deps pulled in by the chat store
vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createMimChatTransport: vi.fn() }))
vi.mock('../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))

import Composer from './Composer.vue'

function factory(props = {}) {
  return shallowMount(Composer, {
    props: {
      modelId: 'test-model',
      models: [],
      controlId: 'ctrl',
      ...props,
    },
  })
}

describe('Composer', () => {
  it('renders with default props', () => {
    const wrapper = factory()
    expect(wrapper.exists()).toBe(true)
    expect(wrapper.find('textarea').attributes('placeholder')).toContain('Ask')
  })

  it('disables browser text assistance on the chat input', () => {
    const textarea = factory().find('textarea')
    expect(textarea.attributes('autocomplete')).toBe('off')
    expect(textarea.attributes('autocorrect')).toBe('off')
    expect(textarea.attributes('autocapitalize')).toBe('off')
    expect(textarea.attributes('spellcheck')).toBe('false')
  })

  it('shows send button when not busy', () => {
    const wrapper = factory({ busy: false })
    expect(wrapper.find('.cmp-send').exists()).toBe(true)
    expect(wrapper.find('.cmp-stop').exists()).toBe(false)
  })

  it('shows stop button when busy', () => {
    const wrapper = factory({ busy: true })
    expect(wrapper.find('.cmp-stop').exists()).toBe(true)
    expect(wrapper.find('.cmp-send').exists()).toBe(false)
  })

  it('emits stop on stop button click', async () => {
    const wrapper = factory({ busy: true })
    await wrapper.find('.cmp-stop').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })

  it('send button disabled when draft is empty', () => {
    const wrapper = factory({ canSend: true })
    expect(wrapper.find('.cmp-send').attributes('disabled')).toBeDefined()
  })

  it('send button enabled when draft has text and canSend is true', async () => {
    const wrapper = factory({ canSend: true })
    await wrapper.find('textarea').setValue('hello')
    expect(wrapper.find('.cmp-send').attributes('disabled')).toBeUndefined()
  })

  it('emits send with trimmed text on Enter', async () => {
    const wrapper = factory({ canSend: true })
    await wrapper.find('textarea').setValue('  hello  ')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeTruthy()
    expect(wrapper.emitted('send')[0]).toEqual([{ text: 'hello', attachments: [] }])
  })

  it('clears draft after send', async () => {
    const wrapper = factory({ canSend: true })
    const textarea = wrapper.find('textarea')
    await textarea.setValue('test')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(textarea.element.value).toBe('')
  })

  it('does not send when disabled', async () => {
    const wrapper = factory({ disabled: true, canSend: true })
    await wrapper.find('textarea').setValue('test')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('does not send when busy', async () => {
    const wrapper = factory({ busy: true, canSend: true })
    const textarea = wrapper.find('textarea')
    await textarea.setValue('test')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('passes cost label to context donut', () => {
    const wrapper = factory({ costLabel: '$1.23', showUsageIndicators: true, contextPercent: 0.1 })
    const donut = wrapper.findComponent({ name: 'ContextDonut' })
    expect(donut.exists()).toBe(true)
    expect(donut.props('costLabel')).toBe('$1.23')
  })

  it('shows budget blocked bar when chat store isBudgetBlocked', () => {
    const chat = useChatStore()
    chat._budgetState = { cost: 100, limit: 50, checked: true }
    const wrapper = factory()
    expect(wrapper.find('.budget-bar.blocked').exists()).toBe(true)
  })

  it('shows budget warning bar when chat store isBudgetWarning', () => {
    const chat = useChatStore()
    chat._budgetState = { cost: 85, limit: 100, checked: true }
    const wrapper = factory()
    expect(wrapper.find('.budget-bar.warning').exists()).toBe(true)
  })

  describe('attachment state', () => {
    it('exposes attachments as empty array initially', () => {
      const wrapper = factory({ canSend: true })
      expect(wrapper.vm.attachments).toEqual([])
    })

    it('addAttachment pushes to the array', () => {
      const wrapper = factory({ canSend: true })
      const result = wrapper.vm.addAttachment({ filename: 'test.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc', size: 1024 })
      expect(result).toBe(null)
      expect(wrapper.vm.attachments).toHaveLength(1)
    })

    it('addAttachment rejects files over 20MB', () => {
      const wrapper = factory({ canSend: true })
      const result = wrapper.vm.addAttachment({ filename: 'big.png', mediaType: 'image/png', dataUrl: 'data:...', size: 21 * 1024 * 1024 })
      expect(result).toBeTruthy() // error string
      expect(wrapper.vm.attachments).toHaveLength(0)
    })

    it('removeAttachment removes by index', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'a.png', mediaType: 'image/png', dataUrl: 'data:a', size: 100 })
      wrapper.vm.addAttachment({ filename: 'b.png', mediaType: 'image/png', dataUrl: 'data:b', size: 100 })
      wrapper.vm.removeAttachment(0)
      expect(wrapper.vm.attachments).toHaveLength(1)
      expect(wrapper.vm.attachments[0].filename).toBe('b.png')
    })

    it('send emits { text, attachments } payload', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'test.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 })
      await wrapper.find('textarea').setValue('hello')
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('send')[0][0]).toEqual({
        text: 'hello',
        attachments: [{ filename: 'test.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 }],
      })
    })

    it('attachments cleared after send', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'test.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 })
      await wrapper.find('textarea').setValue('hello')
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
      expect(wrapper.vm.attachments).toHaveLength(0)
    })

    it('localCanSend is true when text empty but attachments present', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'test.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.cmp-send').attributes('disabled')).toBeUndefined()
    })
  })

  describe('attach menu', () => {
    it('+ button is not disabled', () => {
      const wrapper = factory()
      const btn = wrapper.find('.cmp-icon')
      expect(btn.attributes('disabled')).toBeUndefined()
    })

    it('clicking + button opens the attach menu', async () => {
      const wrapper = factory()
      await wrapper.find('.cmp-icon').trigger('click')
      const menu = wrapper.find('.attach-picker div[class*="bg-surface"]')
      expect(menu.exists()).toBe(true)
    })

    it('menu shows Attach file and Current document', async () => {
      const wrapper = factory({ supportsVision: false })
      await wrapper.find('.cmp-icon').trigger('click')
      const text = wrapper.find('.attach-picker').text()
      expect(text).toContain('Attach file')
      expect(text).toContain('Current document')
    })

    it('Image option visible when supportsVision is true', async () => {
      const wrapper = factory({ supportsVision: true })
      await wrapper.find('.cmp-icon').trigger('click')
      expect(wrapper.find('.attach-picker').text()).toContain('Image')
    })

    it('clicking Image emits attach event', async () => {
      const wrapper = factory({ supportsVision: true })
      await wrapper.find('.cmp-icon').trigger('click')
      const buttons = wrapper.findAll('.attach-picker button')
      const imageBtn = buttons.find(b => b.text().includes('Image'))
      await imageBtn.trigger('click')
      expect(wrapper.emitted('attach')[0]).toEqual(['image'])
    })

    it('clicking Attach file emits attach event', async () => {
      const wrapper = factory({ supportsVision: true })
      await wrapper.find('.cmp-icon').trigger('click')
      const buttons = wrapper.findAll('.attach-picker button')
      const fileBtn = buttons.find(b => b.text().includes('Attach file'))
      await fileBtn.trigger('click')
      expect(wrapper.emitted('attach')[0]).toEqual(['file'])
    })

    it('shows skills section when skills prop provided', async () => {
      const wrapper = factory({ skills: [{ id: 'test', name: 'Test Skill', desc: 'A test' }] })
      await wrapper.find('.cmp-icon').trigger('click')
      expect(wrapper.find('.attach-picker').text()).toContain('Skills')
      expect(wrapper.find('.attach-picker').text()).toContain('Test Skill')
    })
  })

  describe('attachment chips', () => {
    it('renders chips for attachments', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'photo.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('photo.png')
    })

    it('clicking X removes the chip', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'photo.png', mediaType: 'image/png', dataUrl: 'data:x', size: 100 })
      await wrapper.vm.$nextTick()
      const chipButtons = wrapper.findAll('button').filter(b => b.text() === '×')
      await chipButtons[0].trigger('click')
      expect(wrapper.vm.attachments).toHaveLength(0)
    })
  })

  describe('@ detection', () => {
    it('detects @ at start of message', async () => {
      const wrapper = factory({ skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }] })
      wrapper.vm.draft = '@test'
      wrapper.vm.cursorPos = 5
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atQuery).toBe('test')
      expect(wrapper.vm.atActive).toBe(true)
    })

    it('detects @ after whitespace mid-message', async () => {
      const wrapper = factory({ skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }] })
      wrapper.vm.draft = 'hello @test'
      wrapper.vm.cursorPos = 11
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atQuery).toBe('test')
      expect(wrapper.vm.atActive).toBe(true)
    })

    it('does not trigger @ without preceding whitespace', async () => {
      const wrapper = factory({ skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }] })
      wrapper.vm.draft = 'hello@test'
      wrapper.vm.cursorPos = 10
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atQuery).toBe('')
      expect(wrapper.vm.atActive).toBe(false)
    })

    it('shows dropdown when @ active with matching skills', async () => {
      const wrapper = factory({
        skills: [
          { id: 's1', name: 'Alpha', desc: 'first' },
          { id: 's2', name: 'Beta', desc: 'second' },
        ],
      })
      wrapper.vm.draft = '@al'
      wrapper.vm.cursorPos = 3
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.showAtDropdown).toBe(true)
      expect(wrapper.vm.atFilteredSkills).toHaveLength(1)
      expect(wrapper.vm.atFilteredSkills[0].name).toBe('Alpha')
    })
  })

  describe('@ keyboard navigation', () => {
    it('Escape removes the @query from draft', async () => {
      const wrapper = factory({
        skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }],
      })
      wrapper.vm.draft = 'hey @alp'
      wrapper.vm.cursorPos = 8
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.showAtDropdown).toBe(true)

      await wrapper.find('textarea').trigger('keydown', { key: 'Escape' })
      expect(wrapper.vm.draft).toBe('hey ')
    })

    it('Enter with highlight selects the item', async () => {
      const wrapper = factory({
        skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }],
      })
      wrapper.vm.draft = '@alp'
      wrapper.vm.cursorPos = 4
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.showAtDropdown).toBe(true)

      // Navigate down to highlight the first item
      await wrapper.find('textarea').trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.vm.atHighlight).toBe(0)

      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
      // @query should be removed from draft
      expect(wrapper.vm.draft).toBe('')
      // A skill context chip should be added
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0].type).toBe('skill')
      expect(wrapper.vm.contextChips[0].label).toBe('Alpha')
    })
  })

  describe('@ text splicing', () => {
    it('selecting removes only the @query, preserving text before and after', async () => {
      const wrapper = factory({
        skills: [{ id: 's1', name: 'Alpha', desc: 'desc' }],
      })
      wrapper.vm.draft = 'before @alp after'
      // cursor right after @alp (position 11)
      wrapper.vm.cursorPos = 11
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.showAtDropdown).toBe(true)

      // Select the skill directly
      wrapper.vm.selectAtItem('skill', { id: 's1', name: 'Alpha' })
      // @alp should be removed, text before and after preserved
      expect(wrapper.vm.draft).toBe('before  after')
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0].label).toBe('Alpha')
    })
  })

  describe('@ file selection', () => {
    it('selectAtItem file adds a project-file chip and emits pick-project-file', async () => {
      const wrapper = factory({
        projectFiles: [{ path: 'docs/readme.md', name: 'readme.md' }],
      })
      wrapper.vm.draft = '@read'
      wrapper.vm.cursorPos = 5
      await wrapper.vm.$nextTick()

      wrapper.vm.selectAtItem('file', { path: 'docs/readme.md', name: 'readme.md' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0]).toMatchObject({ type: 'project-file', id: 'docs/readme.md', label: 'readme.md' })
      expect(wrapper.emitted('pick-project-file')[0]).toEqual([{ path: 'docs/readme.md', name: 'readme.md' }])
    })

    it('selectAtItem file deduplicates by path', () => {
      const wrapper = factory()
      wrapper.vm.selectAtItem('file', { path: 'a.md', name: 'a.md' })
      wrapper.vm.selectAtItem('file', { path: 'a.md', name: 'a.md' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
    })

    it('selectAtItem file allows different paths', () => {
      const wrapper = factory()
      wrapper.vm.selectAtItem('file', { path: 'a.md', name: 'a.md' })
      wrapper.vm.selectAtItem('file', { path: 'b.md', name: 'b.md' })
      expect(wrapper.vm.contextChips).toHaveLength(2)
    })

    it('keyboard Enter on highlighted file adds chip', async () => {
      const wrapper = factory({
        projectFiles: [{ path: 'notes.md', name: 'notes.md' }],
      })
      wrapper.vm.draft = '@note'
      wrapper.vm.cursorPos = 5
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atFilteredFiles).toHaveLength(1)

      await wrapper.find('textarea').trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.vm.atHighlight).toBe(0)

      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0].type).toBe('project-file')
      expect(wrapper.vm.contextChips[0].label).toBe('notes.md')
      expect(wrapper.emitted('pick-project-file')).toHaveLength(1)
    })
  })

  describe('@ board-entry selection', () => {
    it('selectAtItem board-entry adds chip and emits pick-board-entry', () => {
      const wrapper = factory()
      wrapper.vm.selectAtItem('board-entry', { id: 'e1', title: 'Fix bug', type: 'issue' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0]).toMatchObject({ type: 'board-entry', id: 'e1', label: 'Fix bug', entryType: 'issue' })
      expect(wrapper.emitted('pick-board-entry')[0]).toEqual([{ id: 'e1', title: 'Fix bug', type: 'issue' }])
    })

    it('selectAtItem board-entry deduplicates by id', () => {
      const wrapper = factory()
      wrapper.vm.selectAtItem('board-entry', { id: 'e1', title: 'Fix bug', type: 'issue' })
      wrapper.vm.selectAtItem('board-entry', { id: 'e1', title: 'Fix bug', type: 'issue' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
    })

    it('keyboard Enter on highlighted board entry adds chip', async () => {
      const wrapper = factory({
        boardEntries: [{ id: 'e1', title: 'Login fix', status: 'todo', type: 'issue', tags: [] }],
      })
      wrapper.vm.draft = '@login'
      wrapper.vm.cursorPos = 6
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atFilteredBoard).toHaveLength(1)

      await wrapper.find('textarea').trigger('keydown', { key: 'ArrowDown' })
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0].type).toBe('board-entry')
      expect(wrapper.vm.contextChips[0].label).toBe('Login fix')
      expect(wrapper.emitted('pick-board-entry')).toHaveLength(1)
    })
  })

  describe('context chips', () => {
    it('adds and removes skill chips', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'skill', id: 'test', label: 'Test Skill' })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('Test Skill')
      expect(wrapper.vm.contextChips).toHaveLength(1)
      wrapper.vm.removeContextChip(0)
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.contextChips).toHaveLength(0)
    })

    it('only allows one skill chip', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'skill', id: 'a', label: 'Skill A' })
      wrapper.vm.addContextChip({ type: 'skill', id: 'b', label: 'Skill B' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
      expect(wrapper.vm.contextChips[0].label).toBe('Skill B')
    })

    it('prevents duplicate project-file chips', async () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'project-file', id: '/path/a.md', label: 'a.md' })
      wrapper.vm.addContextChip({ type: 'project-file', id: '/path/a.md', label: 'a.md' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
    })
  })

  describe('board entry chips', () => {
    it('adds board-entry chip from + menu', async () => {
      const wrapper = factory({
        boardEntries: [
          { id: 'e1', title: 'Fix bug', status: 'todo', type: 'task' },
        ],
      })
      wrapper.vm.pickBoardEntryFromMenu({ id: 'e1', title: 'Fix bug' })
      expect(wrapper.emitted('pick-board-entry')).toHaveLength(1)
      expect(wrapper.emitted('pick-board-entry')[0]).toEqual([{ id: 'e1', title: 'Fix bug' }])
    })

    it('prevents duplicate board-entry chips', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'board-entry', id: 'e1', label: 'Fix bug' })
      wrapper.vm.addContextChip({ type: 'board-entry', id: 'e1', label: 'Fix bug' })
      expect(wrapper.vm.contextChips).toHaveLength(1)
    })

    it('@ search filters board entries by title', async () => {
      const wrapper = factory({
        boardEntries: [
          { id: 'e1', title: 'Fix login bug', status: 'todo', type: 'task', tags: [] },
          { id: 'e2', title: 'Add dashboard', status: 'todo', type: 'task', tags: [] },
        ],
      })
      wrapper.vm.draft = '@fix'
      wrapper.vm.cursorPos = 4
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atFilteredBoard).toHaveLength(1)
      expect(wrapper.vm.atFilteredBoard[0].title).toBe('Fix login bug')
    })

    it('@ search filters board entries by tags', async () => {
      const wrapper = factory({
        boardEntries: [
          { id: 'e1', title: 'Task A', status: 'todo', type: 'task', tags: ['urgent'] },
          { id: 'e2', title: 'Task B', status: 'todo', type: 'task', tags: ['low'] },
        ],
      })
      wrapper.vm.draft = '@urgent'
      wrapper.vm.cursorPos = 7
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.atFilteredBoard).toHaveLength(1)
      expect(wrapper.vm.atFilteredBoard[0].title).toBe('Task A')
    })

    it('visibleAttachments hides board-entry attachments that have a context chip', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'board-entry', id: 'e1', label: 'Fix bug', entryType: 'issue' })
      wrapper.vm.addAttachment({ filename: 'Fix bug.md', mediaType: 'text/markdown', content: '# Fix bug', type: 'text', size: 9, _entryId: 'e1' })
      expect(wrapper.vm.attachments).toHaveLength(1)
      expect(wrapper.vm.visibleAttachments).toHaveLength(0)
    })

    it('visibleAttachments shows non-board attachments normally', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addAttachment({ filename: 'notes.txt', mediaType: 'text/plain', content: 'hi', type: 'text', size: 2 })
      expect(wrapper.vm.visibleAttachments).toHaveLength(1)
    })

    it('removeContextChip cleans up associated board-entry attachment', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.addContextChip({ type: 'board-entry', id: 'e1', label: 'Fix bug', entryType: 'issue' })
      wrapper.vm.addAttachment({ filename: 'Fix bug.md', mediaType: 'text/markdown', content: '# Fix bug', type: 'text', size: 9, _entryId: 'e1' })
      expect(wrapper.vm.attachments).toHaveLength(1)
      wrapper.vm.removeContextChip(0)
      expect(wrapper.vm.contextChips).toHaveLength(0)
      expect(wrapper.vm.attachments).toHaveLength(0)
    })

    it('stores entryType on board-entry chip', () => {
      const wrapper = factory({ canSend: true })
      wrapper.vm.pickBoardEntryFromMenu({ id: 'e1', title: 'My issue', type: 'issue' })
      expect(wrapper.vm.contextChips[0].entryType).toBe('issue')
      wrapper.vm.pickBoardEntryFromMenu({ id: 'e2', title: 'My note', type: 'knowledge' })
      expect(wrapper.vm.contextChips[1].entryType).toBe('knowledge')
    })
  })
})
