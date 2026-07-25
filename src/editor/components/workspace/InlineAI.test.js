import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import InlineAI from './InlineAI.vue'

const mocks = vi.hoisted(() => ({
  registry: null,
  statuses: [],
  chats: [],
  getConfig: null,
  sendError: null,
}))

vi.mock('../../../services/ai/client.js', () => ({
  getModelRegistry: vi.fn(async () => mocks.registry),
  getAiKeyStatus: vi.fn(async () => mocks.statuses),
}))

vi.mock('../../../services/ai/inlineTransport.js', () => ({
  buildInlineSystemPrompt: vi.fn(() => 'system'),
  createInlineAITransport: vi.fn((getConfig) => {
    mocks.getConfig = getConfig
    return {}
  }),
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    constructor(options) {
      this.options = options
      this.state = {
        statusRef: ref('ready'),
        errorRef: ref(null),
        messagesRef: ref([]),
      }
      this.sendMessage = vi.fn(() => {
        if (mocks.sendError) throw mocks.sendError
        return Promise.resolve()
      })
      this.stop = vi.fn()
      mocks.chats.push(this)
    }
  },
}))

const ModelPickerStub = defineComponent({
  props: ['modelId', 'models'],
  emits: ['update:modelId'],
  template: '<button data-model-picker :data-model-id="modelId" @click="$emit(\'update:modelId\', models[0]?.id)">{{ modelId }}</button>',
})

function registry() {
  return {
    models: [
      { id: 'cheap', provider: 'openai', capabilities: { streaming: true, tools: true } },
      { id: 'best-rewrite', provider: 'anthropic', capabilities: { streaming: true, tools: true } },
    ],
    defaults: { rewrite: ['best-rewrite', 'cheap'] },
  }
}

function render(props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(InlineAI, {
    props: {
      selection: {
        text: 'A short selection',
        from: 5,
        to: 22,
        contextBefore: 'Before',
        contextAfter: 'After',
      },
      ...props,
    },
    global: {
      plugins: [pinia],
      stubs: { ModelPicker: ModelPickerStub },
    },
  })
}

async function enterInstruction(wrapper, text = 'Make this clearer') {
  await wrapper.get('textarea').setValue(text)
  await wrapper.get('form').trigger('submit')
  await nextTick()
}

describe('InlineAI', () => {
  beforeEach(() => {
    mocks.registry = registry()
    mocks.statuses = [
      { provider: 'openai', configured: true },
      { provider: 'anthropic', configured: true },
    ]
    mocks.chats.length = 0
    mocks.getConfig = null
    mocks.sendError = null
  })

  it('keeps Auto stored while resolving the registry rewrite default per request', async () => {
    const wrapper = render()
    const settings = useSettingsStore()
    await flushPromises()

    expect(settings.aiInlineModel).toBe('auto')
    expect(wrapper.get('[data-model-picker]').attributes('data-model-id')).toBe('best-rewrite')
    expect(wrapper.get('[data-inline-ai-scope]').text()).toBe('3 words')

    await enterInstruction(wrapper)
    expect(mocks.chats[0].sendMessage).toHaveBeenCalledWith({ text: 'Make this clearer' })
    expect(mocks.getConfig().modelId).toBe('best-rewrite')
    expect(settings.aiInlineModel).toBe('auto')
  })

  it('disables Send and presents a direct configuration action with no usable provider', async () => {
    mocks.statuses = [
      { provider: 'openai', configured: false },
      { provider: 'anthropic', configured: false },
    ]
    const wrapper = render()
    await flushPromises()
    await wrapper.get('textarea').setValue('Rewrite')

    expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).toContain('Configure an AI provider key')
    const configure = wrapper.findAll('button').find(button => button.text() === 'Configure AI')
    await configure.trigger('click')
    expect(wrapper.emitted('configure-models')).toHaveLength(1)
    expect(mocks.chats).toHaveLength(0)
  })

  it('keeps accept/reject controls visible when a tool proposes an edit without prose', async () => {
    const wrapper = render()
    await flushPromises()
    await enterInstruction(wrapper)

    mocks.getConfig().onEdit({ replacement: 'Clearer text' })
    await nextTick()

    expect(wrapper.text()).toContain('Review the proposed edit.')
    await wrapper.get('button[aria-label="Accept AI edit"]').trigger('click')
    expect(wrapper.emitted('apply')[0]).toEqual(['Clearer text', 5, 22])
  })

  it('reports synchronous send failures and retries the exact instruction', async () => {
    mocks.sendError = new Error('Provider unavailable')
    const wrapper = render()
    await flushPromises()
    await enterInstruction(wrapper, 'Keep this exact')

    expect(wrapper.text()).toContain('Provider unavailable')
    mocks.sendError = null
    const retry = wrapper.findAll('button').find(button => button.text() === 'Retry')
    await retry.trigger('click')
    await flushPromises()
    expect(mocks.chats[0].sendMessage).toHaveBeenLastCalledWith({ text: 'Keep this exact' })
  })

  it('cancels streaming and respects a higher modal before handling Escape', async () => {
    const wrapper = render({ escapeBlocked: true })
    await flushPromises()
    await enterInstruction(wrapper)
    const chat = mocks.chats[0]
    chat.state.statusRef.value = 'streaming'
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(chat.stop).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeFalsy()

    await wrapper.setProps({ escapeBlocked: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(chat.stop).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('accepts a pending edit with the primary-modifier Enter shortcut', async () => {
    const wrapper = render()
    await flushPromises()
    await enterInstruction(wrapper)
    mocks.getConfig().onEdit({ replacement: 'Accepted by key' })
    await nextTick()

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', metaKey: true })
    expect(wrapper.emitted('apply').at(-1)).toEqual(['Accepted by key', 5, 22])
  })
})
