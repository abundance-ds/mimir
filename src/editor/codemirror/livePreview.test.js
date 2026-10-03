import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EditorState, EditorSelection, StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { syntaxHighlighting, syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { livePreviewExtension, _buildDecorations, _parseMarkdownTable, _resolveImagePath } from './livePreview.js'
import { markdownLinkOpen } from './markdownLinks.js'
import { editorHighlightStyle } from './core.js'
import { commentsExtension } from './comments.js'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function makeView(doc, cursorPos = 0) {
  const parent = document.createElement('div')
  const state = EditorState.create({
    doc,
    selection: typeof cursorPos === 'number' ? { anchor: cursorPos } : cursorPos,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
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
  describe('blockquotes', () => {
    const doc = '> here is\n> a block quote\n\noutside'

    it.each([0, 4, 10, 11, 12, 18])('reveals only the cursor line at position %i', cursor => {
      const decos = getDecos(doc, cursor)
      const hiddenLine = cursor < 10 ? 10 : 0
      expect(decos.filter(d => d.replace).map(d => [d.from, d.to]))
        .toEqual([[hiddenLine, hiddenLine + 2]])
      expect(decos.filter(d => d.class === 'cm-lp-blockquote-line').map(d => d.from))
        .toEqual([hiddenLine])
    })

    it.each([
      { anchor: 4, head: 18 },
      { anchor: 18, head: 4 },
      EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(18)]),
    ])('reveals all selected quote lines', selection => {
      expect(getDecos(doc, selection)).toEqual([])
    })

    it('hides nested markers once and adds one border per line', () => {
      const text = '> > one\n> > two\n\noutside'
      const decos = getDecos(text, text.length)
      expect(decos.filter(d => d.replace).map(d => [d.from, d.to]))
        .toEqual([[0, 2], [2, 4], [8, 10], [10, 12]])
      expect(decos.filter(d => d.class === 'cm-lp-blockquote-line').map(d => d.from))
        .toEqual([0, 8])
      expect(getDecos(text, 14).filter(d => d.replace).map(d => d.from))
        .toEqual([0, 2])
    })

    it.each([
      ['>one\n>two\n\noutside', ['>', '>']],
      ['> one\n>\n> two\n\noutside', ['> ', '>', '> ']],
      ['>\tone\n>  two\n\noutside', ['>\t', '> ']],
      ['outside\n\n>', ['>']],
    ])('hides only markers and optional whitespace in %j', (text, hidden) => {
      const decos = getDecos(text, text.indexOf('outside'))
      expect(decos.filter(d => d.replace).map(d => text.slice(d.from, d.to))).toEqual(hidden)
    })

    it.each(['> **one\n> two**', '> ```js\n> foo\n> ```'])('keeps quote markers hidden inside %j', quote => {
      const text = quote + '\n\noutside'
      const decos = getDecos(text, text.length)
      const quoteMarks = decos.filter(d => d.replace && text[d.from] === '>')
      expect(quoteMarks.map(d => text.slice(d.from, d.to)))
        .toEqual(Array(quote.split('\n').length).fill('> '))
      const active = getDecos(text, text.indexOf('\n') + 3)
      expect(active.some(d => d.replace && d.from === text.indexOf('\n') + 1)).toBe(false)
    })

    it('keeps the border on lazy continuation lines only when inactive', () => {
      const text = '> one\nlazy\n\noutside'
      expect(getDecos(text, text.length).filter(d => d.class === 'cm-lp-blockquote-line').map(d => d.from))
        .toEqual([0, 6])
      expect(getDecos(text, 7).filter(d => d.class === 'cm-lp-blockquote-line').map(d => d.from))
        .toEqual([0])
    })

    it('limits a long quote to the viewport margin', () => {
      const text = '> line\n'.repeat(400) + '\noutside'
      const state = EditorState.create({
        doc: text,
        selection: { anchor: text.length },
        extensions: [markdown({ base: markdownLanguage })],
      })
      ensureSyntaxTree(state, text.length, 1000)
      const decorations = _buildDecorations({ state, viewport: { from: 1400, to: 1470 } }, () => true)
      const hidden = []
      const borders = []
      for (let iter = decorations.iter(); iter.value; iter.next()) {
        if (iter.value.spec.class) borders.push(iter.from)
        else hidden.push(iter.from)
      }
      expect(hidden).toContain(1400)
      expect(hidden.every(from => from >= 899 && from <= 1970)).toBe(true)
      expect(borders.every(from => from >= state.doc.lineAt(900).from && from <= 1970)).toBe(true)
    })

    it.each([
      ['Backspace', 12, '> here is\na block quote\n\noutside'],
      ['Delete', 10, '> here is\n a block quote\n\noutside'],
    ])('reveals the second marker and permits %s without joining lines', (key, cursor, expected) => {
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [markdown({ base: markdownLanguage }), history(), keymap.of(defaultKeymap),
            livePreviewExtension(() => true, () => '/test.md')],
        }),
      })
      try {
        const lines = () => [...view.contentDOM.querySelectorAll('.cm-line')].map(line => line.textContent)
        expect(lines().slice(0, 2)).toEqual(['here is', 'a block quote'])
        view.dispatch({ selection: { anchor: cursor } })
        expect(lines().slice(0, 2)).toEqual(['here is', '> a block quote'])
        view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        expect(view.state.doc.toString()).toBe(expected)
        expect(undo(view)).toBe(true)
        expect(view.state.doc.toString()).toBe(doc)
        view.dispatch({ selection: { anchor: doc.length } })
        expect(lines().slice(0, 2)).toEqual(['here is', 'a block quote'])
      } finally {
        view.destroy()
        parent.remove()
      }
    })
  })

  describe('buildDecorations', () => {
    it('returns no decorations when disabled', () => {
      const view = makeView('**bold**')
      const decos = _buildDecorations(view, () => false, null)
      expect(decos.size).toBe(0)
      view.destroy()
    })

    it('places a blockquote line decoration before its hidden quote mark', () => {
      // Regression: sorting by the Range's missing startSide left the quote
      // mark ahead of the line decoration, and RangeSetBuilder threw, which
      // disabled Live Preview for the whole document.
      const decos = getDecos('Intro\n\n> A quote with **bold** inside.\n')
      const line = decos.find(d => d.class === 'cm-lp-blockquote-line')
      expect(line).toBeTruthy()
      expect(decos.find(d => d.from === line.from).class).toBe('cm-lp-blockquote-line')
    })

    it('keeps heading marker colour when Live Preview is disabled', () => {
      const view = makeView('## Heading')
      const decos = _buildDecorations(view, () => false, null)
      const iter = decos.iter()
      expect(iter.value?.spec?.class).toBe('cm-lp-heading-mark')
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

    it('makes bare and angle-bracket web URLs actionable away from the cursor', () => {
      const doc = 'https://example.com/docs\n<https://example.com/help>\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const links = decos.filter(d => d.class === 'cm-lp-link')
      expect(links).toHaveLength(2)
    })

    it('does not mark unsafe or document-only destinations as actionable', () => {
      const doc = '[unsafe](javascript:alert(1))\n[jump](#components)\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      expect(decos.filter(d => d.class === 'cm-lp-link')).toHaveLength(0)
    })

    it('styles heading marks when cursor is away', () => {
      const doc = '# Heading\n\nother'
      const cursorPos = doc.indexOf('other')
      const decos = getDecos(doc, cursorPos)
      const headingMark = decos.filter(d => d.class === 'cm-lp-heading-mark')
      expect(headingMark.length).toBe(1)
    })

    it('keeps heading marker colour when cursor is on heading line', () => {
      const doc = '# Heading'
      const decos = getDecos(doc, 3)
      expect(decos.filter(d => d.class === 'cm-lp-heading-mark')).toHaveLength(1)
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

  describe('rendered link interaction', () => {
    it('keeps empty header and body cells in their original columns', () => {
      const doc = '| Who | Item | Monthly | 12 months |\n| --- | --- | ---: | ---: |\n'
        + '| General | Workspace Standard × 3 | €58 | €696 |\n'
        + '| | GitHub Team × 4 | €18 | €216 |\n'
        + '| | **General subtotal** | **€311** | **€3,732** |\n'
        + '| **TOTAL** | | **€1,506** | **€23,312** |\n'
        + '| | | [File](guide.md) | |\n\n'
        + '| | Label | |\n| --- | --- | --- |\n| | value | |\n\nafter'
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc, selection: { anchor: doc.length },
          extensions: [markdown({ base: markdownLanguage }), livePreviewExtension(() => true, () => '/work/README.md')],
        }),
      })
      const tables = view.dom.querySelectorAll('table')
      const rows = [...tables[0].querySelectorAll('tbody tr')]
      expect(rows.map(row => [...row.cells].map(cell => cell.textContent))).toEqual([
        ['General', 'Workspace Standard × 3', '€58', '€696'],
        ['', 'GitHub Team × 4', '€18', '€216'],
        ['', 'General subtotal', '€311', '€3,732'],
        ['TOTAL', '', '€1,506', '€23,312'],
        ['', '', 'File', ''],
      ])
      expect(rows[1].cells[2].style.textAlign).toBe('right')
      expect(rows[3].cells[2].querySelector('strong').textContent).toBe('€1,506')
      expect(rows[4].cells[2].querySelector('.cm-lp-link').dataset.markdownDestination).toBe('guide.md')
      expect([...tables[1].querySelectorAll('th')].map(cell => cell.textContent)).toEqual(['', 'Label', ''])
      expect([...tables[1].querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['', 'value', ''])
      view.destroy()
    })

    it('conceals table comments and replies while preserving cells, formatting, and source', () => {
      const doc = 'before\n\n| <comment id="h" text="Header">**Guide**</comment> | Status |\n'
        + '| --- | --- |\n'
        + '| <comment id="c" text="Choose A | B">[File](guide.md)<reply id="r" text="Yes | agreed"/></comment> | Ready |\n'
        + '| <comment id="done" status="resolved" text="Done">*Resolved*</comment> | <b>literal</b> |\n\nafter'
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc, selection: { anchor: doc.length },
          extensions: [
            markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
            livePreviewExtension(() => true, () => '/work/README.md'),
            commentsExtension(),
          ],
        }),
      })
      const checkTable = () => {
        const table = view.dom.querySelector('table')
        expect(table).not.toBeNull()
        expect([...table.querySelectorAll('th')].map(cell => cell.textContent)).toEqual(['Guide1 comment', 'Status'])
        expect([...table.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['File1 comment', 'Ready', 'Resolved', '<b>literal</b>'])
        expect(table.querySelector('strong').textContent).toBe('Guide')
        expect(table.querySelector('em').textContent).toBe('Resolved')
        expect(table.querySelector('.cm-lp-link').dataset.markdownDestination).toBe('guide.md')
        expect(table.querySelector('b')).toBeNull()
      }
      checkTable()
      view.dispatch({ selection: { anchor: doc.indexOf('Ready') } })
      expect(view.dom.querySelector('table')).toBeNull()
      const sourceLines = [...view.contentDOM.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')
      expect(sourceLines).toContain('Ready')
      expect(sourceLines).not.toContain('<comment')
      expect(sourceLines).not.toContain('<reply')
      view.dispatch({ selection: { anchor: doc.length } })
      checkTable()
      expect(view.state.doc.toString()).toBe(doc)
      view.destroy()
    })

    it('renders table inline content and opens each cell destination without coordinate lookup', () => {
      const doc = '| [**Guide**](guide.md "Title") | Format |\n| --- | --- |\n'
        + '| [Web](https://example.com) | *italic* and `code` and ~~old~~ |\n'
        + '| <https://example.org> | a\\|b |\n'
        + '| [Unsafe](javascript:alert) | <img src=x onerror=alert(1)> |\n\nother'
      const onOpenFile = vi.fn()
      const onOpenUrl = vi.fn()
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc, selection: { anchor: doc.length },
          extensions: [
            markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
            livePreviewExtension(() => true, () => '/work/README.md'),
            markdownLinkOpen({ selector: '.cm-lp-link', preserveRenderedLink: true, onOpenFile, onOpenUrl }),
          ],
        }),
      })
      const coords = vi.spyOn(view, 'posAtCoords').mockReturnValue(null)
      const table = view.dom.querySelector('table')
      expect(table.querySelector('th strong').textContent).toBe('Guide')
      expect(table.querySelector('th .cm-lp-link').textContent).toBe('Guide')
      expect(table.querySelector('em').textContent).toBe('italic')
      expect(table.querySelector('code').textContent).toBe('code')
      expect(table.querySelector('s').textContent).toBe('old')
      expect(table.textContent).toContain('a|b')
      expect(table.querySelector('img')).toBeNull()
      expect(table.textContent).toContain('[Unsafe](javascript:alert)')
      const links = table.querySelectorAll('.cm-lp-link')
      expect(links).toHaveLength(3)
      for (const link of links) {
        const target = link.firstElementChild || link
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      }
      expect(onOpenFile).toHaveBeenCalledWith('guide.md')
      expect(onOpenUrl.mock.calls).toEqual([['https://example.com/'], ['https://example.org/']])
      expect(coords).not.toHaveBeenCalled()
      expect(view.state.selection.main.head).toBe(doc.length)
      view.dispatch({ selection: { anchor: doc.indexOf('Web') } })
      expect(view.dom.querySelector('table')).toBeNull()
      view.dispatch({ selection: { anchor: doc.length } })
      expect(view.dom.querySelectorAll('table .cm-lp-link')).toHaveLength(3)
      view.destroy()
    })

    it('opens a rendered file link with one click without moving the caret', () => {
      const doc = '[Layout](layout-2.html)\n\nother'
      const cursor = doc.indexOf('other')
      const onOpenFile = vi.fn()
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      const state = EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: [
          markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
          livePreviewExtension(() => true, () => '/work/README.md'),
          markdownLinkOpen({
            selector: '.cm-lp-link',
            preserveRenderedLink: true,
            onOpenFile,
          }),
        ],
      })
      ensureSyntaxTree(state, state.doc.length, 1000)
      const view = new EditorView({ state, parent })
      vi.spyOn(view, 'posAtCoords').mockReturnValue(doc.indexOf('Layout') + 2)
      const link = view.dom.querySelector('.cm-lp-link')

      expect(link).not.toBeNull()
      link.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }))
      link.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }))

      expect(onOpenFile).toHaveBeenCalledWith('layout-2.html')
      expect(view.state.selection.main.head).toBe(cursor)
      view.destroy()
      parent.remove()
    })
  })

  describe('rendered heading marks', () => {
    it('keeps the accent on the nested marker span', () => {
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      document.documentElement.style.setProperty('--editor-heading-1', 'rgb(18, 52, 86)')
      document.documentElement.style.setProperty('--color-ink', 'rgb(220, 220, 220)')

      const state = EditorState.create({
        doc: '## Heading',
        selection: { anchor: 4 },
        extensions: [
          markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
          syntaxHighlighting(editorHighlightStyle),
          livePreviewExtension(() => false, () => '/test/file.md'),
        ],
      })
      const view = new EditorView({ state, parent })
      const marker = view.dom.querySelector('.cm-lp-heading-mark > span')
      const heading = view.dom.querySelector('.cm-lp-heading-mark + span')

      expect(getComputedStyle(marker).color).toBe('rgb(18, 52, 86)')
      expect(getComputedStyle(heading).color).toBe('rgb(220, 220, 220)')
      view.destroy()
      parent.remove()
      document.documentElement.style.removeProperty('--editor-heading-1')
      document.documentElement.style.removeProperty('--color-ink')
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
