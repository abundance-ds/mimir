import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { EditorView } from '@codemirror/view'
import { useSettingsStore } from '../../../stores/settings.js'
import EditorSurface from './EditorSurface.vue'
import GraphMarkdownEditor from '../../../mimir/apps/business-graph/GraphMarkdownEditor.vue'
import ScribeMarkdownEditor from '../../../mimir/apps/scribe/ScribeMarkdownEditor.vue'

vi.mock('../../../services/spelling.js', () => ({
  checkSpelling: vi.fn(async text => [...text.matchAll(/mispeled/g)].map(match => ({ from: match.index, to: match.index + 8 }))),
  spellingSuggestions: vi.fn(async () => ['misspelled']),
}))

describe.each([
  ['Editor and Scratchpad', EditorSurface, { content: 'mispeled', path: '/notes/test.md' }],
  ['Graph', GraphMarkdownEditor, { modelValue: 'mispeled' }],
  ['Scribe', ScribeMarkdownEditor, { modelValue: 'mispeled', ariaLabel: 'Notes' }],
])('%s spelling', (_, component, props) => {
  let wrapper
  afterEach(() => { wrapper?.unmount() })

  it('keeps underlines and keyboard corrections while native spellcheck stays off', async () => {
    const settings = useSettingsStore()
    settings.editorSpellCheck = true
    wrapper = mount(component, { props, attachTo: document.body })
    const content = wrapper.get('.cm-content')
    const view = EditorView.findFromDOM(content.element)
    await vi.waitFor(() => expect(wrapper.find('.cm-misspelled').text()).toBe('mispeled'))
    expect(content.attributes('spellcheck')).toBe('false')
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 40, right: 40, top: 50, bottom: 70 })
    view.dispatch({ selection: { anchor: 8 } })
    await content.trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    const suggestion = document.querySelector('.spell-item')
    expect(suggestion?.textContent).toBe('misspelled')
    suggestion.click()
    await flushPromises()
    expect(view.state.doc.toString()).toBe('misspelled')
    settings.editorSpellCheck = false
    await flushPromises()
    expect(wrapper.find('.cm-misspelled').exists()).toBe(false)
    expect(content.attributes('spellcheck')).toBe('false')
  })
})
