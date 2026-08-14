import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EditorState, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { livePreviewExtension, _buildDecorations, _parseMarkdownTable, _resolveImagePath } from './livePreview.js'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function makeView(doc, cursorPos = 0) {
  const parent = document.createElement('div')
  const state = EditorState.create({
    doc,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
    ],
  })
  const view = new EditorView({ state, parent })
  ensureSyntaxTree(view.state, view.state.doc.length, 1000)
  return view
}

function getDecos(doc, cursorPos = 0) {
  const view = makeView(doc, cursorPos)
  const decos = _buildDecorations(view, () => true, () => '/test/file.md')
  const result = []
  const iter = decos.iter()
  while (iter.value) {
    const isReplace = iter.value.spec?.widget !== undefined || (iter.value.startSide > 0 && !iter.value.spec?.class)
    result.push({
      from: iter.from,
      to: iter.to,
      class: iter.value.spec?.class,
      widget: iter.value.spec?.widget?.constructor?.name,
      replace: isReplace,
    })
    iter.next()
  }
  view.destroy()
  return result
}

describe('livePreview', () => {
  describe('buildDecorations', () => {
    it('returns no decorations when disabled', () => {
      const view = makeView('**bold**')
      const decos = _buildDecorations(view, () => false, null)
      expect(decos.size).toBe(0)
      view.destroy()
    })

    it('hides bold markers and styles content when cursor is elsewhere', () => {
      const doc = '**bold**\n\nother line'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const replaced = decos.filter(d => d.replace && !d.class)
      const bold = decos.filter(d => d.class === 'cm-lp-bold')
      expect(replaced.length).toBe(2)
      expect(bold.length).toBe(1)
    })

    it('does not hide bold markers when cursor is on the same line', () => {
      const doc = '**bold** text'
      const decos = getDecos(doc, 3)
      expect(decos.length).toBe(0)
    })

    it('hides italic markers and styles content', () => {
      const doc = '*italic*\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const replaced = decos.filter(d => d.replace && !d.class)
      const italic = decos.filter(d => d.class === 'cm-lp-italic')
      expect(replaced.length).toBe(2)
      expect(italic.length).toBe(1)
    })

    it('hides strikethrough markers', () => {
      const doc = '~~struck~~\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const replaced = decos.filter(d => d.replace && !d.class)
      const strike = decos.filter(d => d.class === 'cm-lp-strike')
      expect(replaced.length).toBe(2)
      expect(strike.length).toBe(1)
    })

    it('hides inline code backticks', () => {
      const doc = '`code`\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const replaced = decos.filter(d => d.replace && !d.class)
      expect(replaced.length).toBe(2)
    })

    it('hides link syntax and styles link text', () => {
      const doc = '[text](https://example.com)\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const replaced = decos.filter(d => d.replace && !d.class)
      const link = decos.filter(d => d.class === 'cm-lp-link')
      expect(replaced.length).toBeGreaterThanOrEqual(2)
      expect(link.length).toBe(1)
    })

    it('dims heading marks when cursor is away', () => {
      const doc = '# Heading\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const headingMark = decos.filter(d => d.class === 'cm-lp-heading-mark')
      expect(headingMark.length).toBe(1)
    })

    it('does not dim heading marks when cursor is on heading line', () => {
      const doc = '# Heading'
      const decos = getDecos(doc, 3)
      expect(decos.length).toBe(0)
    })

    it('replaces horizontal rule with widget', () => {
      const doc = '---\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const hr = decos.filter(d => d.widget === 'HrWidget')
      expect(hr.length).toBe(1)
    })

    it('does not process inside fenced code blocks', () => {
      const doc = '```\n**bold**\n```\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const bold = decos.filter(d => d.class === 'cm-lp-bold')
      expect(bold.length).toBe(0)
    })

    it('handles multi-line selection keeping all lines raw', () => {
      const doc = '**line1**\n**line2**\n**line3**'
      const view = makeView(doc, 0)
      const state = view.state
      ensureSyntaxTree(state, state.doc.length, 1000)

      const stateWithSel = state.update({
        selection: { anchor: 0, head: doc.indexOf('line2') + 3 },
      }).state
      const view2 = new EditorView({
        state: stateWithSel,
        parent: document.createElement('div'),
      })
      ensureSyntaxTree(view2.state, view2.state.doc.length, 1000)

      const decos = _buildDecorations(view2, () => true, null)
      const result = []
      const iter = decos.iter()
      while (iter.value) {
        result.push({ from: iter.from, to: iter.to, class: iter.value.spec?.class })
        iter.next()
      }

      const boldOnLine3 = result.filter(d => d.class === 'cm-lp-bold' && d.from >= doc.indexOf('line3'))
      expect(boldOnLine3.length).toBe(1)

      view.destroy()
      view2.destroy()
    })
  })

  describe('deferred syntax tree', () => {
    // The Markdown parser runs asynchronously: when a file first opens, the
    // plugin builds before the tree exists. A parse-progress transaction has
    // no doc/selection change, so the plugin must rebuild on tree identity.
    function mountWithoutLanguage(doc, cursorPos) {
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      const state = EditorState.create({
        doc,
        selection: { anchor: cursorPos },
        extensions: [livePreviewExtension(() => true, () => '/test/file.md')],
      })
      const view = new EditorView({ state, parent })
      return view
    }

    function attachLanguage(view) {
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
        ),
      })
    }

    it('renders inline decorations once the tree arrives without doc or selection changes', () => {
      const doc = '**bold**\n\nother'
      const view = mountWithoutLanguage(doc, doc.indexOf('other'))
      expect(view.contentDOM.textContent).toContain('**')

      attachLanguage(view)
      expect(view.contentDOM.textContent).not.toContain('**')
      expect(view.contentDOM.textContent).toContain('bold')
      view.destroy()
    })

    it('renders the table widget once the tree arrives without doc or selection changes', () => {
      const doc = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nother'
      const view = mountWithoutLanguage(doc, doc.indexOf('other'))
      expect(view.dom.querySelector('.cm-lp-table')).toBeNull()

      attachLanguage(view)
      expect(view.dom.querySelector('.cm-lp-table')).not.toBeNull()
      view.destroy()
    })
  })

  describe('parseMarkdownTable', () => {
    it('parses a simple table', () => {
      const text = '| A | B |\n| --- | --- |\n| 1 | 2 |'
      const result = _parseMarkdownTable(text)
      expect(result).not.toBeNull()
      expect(result.headers).toEqual(['A', 'B'])
      expect(result.rows).toEqual([['1', '2']])
      expect(result.alignments).toEqual(['left', 'left'])
    })

    it('detects column alignment', () => {
      const text = '| L | C | R |\n| --- | :---: | ---: |\n| a | b | c |'
      const result = _parseMarkdownTable(text)
      expect(result.alignments).toEqual(['left', 'center', 'right'])
    })

    it('returns null for invalid table', () => {
      expect(_parseMarkdownTable('not a table')).toBeNull()
      expect(_parseMarkdownTable('| header |\n| nope |')).toBeNull()
    })

    it('handles escaped pipes', () => {
      const text = '| A |\n| --- |\n| a\\|b |'
      const result = _parseMarkdownTable(text)
      expect(result.rows[0]).toEqual(['a|b'])
    })
  })

  describe('resolveImagePath', () => {
    it('returns remote URLs unchanged', () => {
      expect(_resolveImagePath('https://example.com/img.png', '/a/b.md')).toBe('https://example.com/img.png')
    })

    it('returns absolute paths unchanged', () => {
      expect(_resolveImagePath('/abs/path/img.png', '/a/b.md')).toBe('/abs/path/img.png')
    })

    it('resolves relative paths against file directory', () => {
      expect(_resolveImagePath('img.png', '/docs/file.md')).toBe('/docs/img.png')
      expect(_resolveImagePath('../img.png', '/docs/sub/file.md')).toBe('/docs/img.png')
    })

    it('decodes URI-encoded paths', () => {
      expect(_resolveImagePath('my%20image.png', '/docs/file.md')).toBe('/docs/my image.png')
    })
  })
})
