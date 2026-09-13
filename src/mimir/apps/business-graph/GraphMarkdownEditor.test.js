import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'

function styleRuleCount() {
  return [...document.querySelectorAll('style')]
    .reduce((count, style) => count + (style.sheet?.cssRules.length || 0), 0)
}

describe('GraphMarkdownEditor styles', () => {
  it('does not rewrite the shared stylesheet when another entry uses the same editor styles', () => {
    function openAndClose(modelValue) {
      const wrapper = mount(GraphMarkdownEditor, {
        attachTo: document.body,
        props: { framed: false, openLinks: true, modelValue },
      })
      wrapper.unmount()
    }
    openAndClose('# First entry')
    const sheets = [...document.querySelectorAll('style')]
    expect(sheets.length).toBeGreaterThan(0)
    const observer = new MutationObserver(() => {})
    for (const sheet of sheets) observer.observe(sheet, { childList: true, characterData: true, subtree: true })
    try {
      openAndClose('A different working note.')
      openAndClose('## Another entry\n\n**Evidence** to review.')
      expect(observer.takeRecords()).toHaveLength(0)
    } finally {
      observer.disconnect()
    }
  })

  it('keeps the document stylesheet bounded across repeated opens and editor variants', () => {
    const variants = [
      { framed: true, openLinks: false },
      { framed: false, openLinks: true },
      { framed: true, openLinks: true },
      { framed: false, openLinks: false },
    ]
    function openAndClose(props) {
      const wrapper = mount(GraphMarkdownEditor, {
        attachTo: document.body,
        props: { ...props, modelValue: '# Evidence\n\n**Review** the [source](https://example.com).' },
      })
      try {
        expect(wrapper.find('.cm-editor').exists()).toBe(true)
      } finally {
        wrapper.unmount()
      }
    }

    variants.forEach(openAndClose)
    const rules = styleRuleCount()
    expect(rules).toBeGreaterThan(0)
    for (let pass = 0; pass < 3; pass += 1) {
      for (const props of [...variants].reverse()) {
        openAndClose(props)
        expect(styleRuleCount()).toBe(rules)
      }
    }
  })
})
