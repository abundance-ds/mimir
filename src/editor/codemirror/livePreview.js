import { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { language, syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, StateEffect, Prec } from '@codemirror/state'
import { readBinaryFile } from '../../services/fileSystem.js'
import { markdownLinkDestination } from './markdownLinks.js'
import { stripCommentTags } from '../../services/comments/parser.js'
import { commentTagField, commentWidgetConfig, tableCommentIds, setActiveComment, setResolvedCommentsVisible } from './comments.js'
import { tableComments, appendCommentText, addTableComments, tableCommentsController } from './tableComments.js'

import { addTableResizeControls, tableResizeController } from './tableResize.js'

const imageCache = new Map()

function getMimeType(path) {
  const ext = path.split('.').pop()?.toLowerCase()
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
                bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff' }
  return map[ext] || 'image/png'
}

function isRemoteUrl(src) {
  return /^https?:\/\//i.test(src)
}

function resolveImagePath(src, filePath) {
  if (isRemoteUrl(src)) return src
  const decoded = decodeURIComponent(src)
  if (decoded.startsWith('/')) return decoded
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  const parts = `${dir}/${decoded}`.split('/')
  const resolved = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.') resolved.push(part)
  }
  return resolved.join('/')
}

function parseMarkdownTable(text) {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return null

  const splitRow = (line) => {
    let trimmed = line.trim()
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
    const cells = []
    let current = ''
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
        current += '|'
        i++
      } else if (trimmed[i] === '|') {
        cells.push(current.trim())
        current = ''
      } else {
        current += trimmed[i]
      }
    }
    cells.push(current.trim())
    return cells
  }

  const headerCells = splitRow(lines[0])
  const delimCells = splitRow(lines[1])

  const isDelimiter = delimCells.every(c => /^:?-+:?$/.test(c.trim()))
  if (!isDelimiter) return null

  const alignments = delimCells.map(cell => {
    const d = cell.trim()
    const left = d.startsWith(':')
    const right = d.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })

  const rows = []
  for (let i = 2; i < lines.length; i++) {
    rows.push(splitRow(lines[i]))
  }

  return { headers: headerCells, alignments, rows }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement('hr')
    el.className = 'cm-lp-hr'
    return el
  }
  eq() { return true }
  ignoreEvent() { return false }
}

// Render parsed inline nodes with DOM methods. Never interpret authored HTML.
function renderTableInline(parent, node, text, offset, comments = []) {
  const raw = text.slice(node.from - offset, node.to - offset)
  const formats = {
    StrongEmphasis: ['strong', 'cm-lp-bold'],
    Emphasis: ['em', 'cm-lp-italic'],
    Strikethrough: ['s', 'cm-lp-strike'],
    InlineCode: ['code', 'cm-lp-code'],
  }
  let container = parent
  if (node.name === 'Link' || node.name === 'Autolink' || node.name === 'URL') {
    const url = node.name === 'URL' ? node : node.getChild('URL')
    const target = url && text.slice(url.from - offset, url.to - offset)
    if (!markdownLinkDestination(target)) {
      appendCommentText(parent, raw, node.from - offset, comments)
      return
    }
    container = document.createElement('span')
    container.className = 'cm-lp-link'
    container.dataset.markdownDestination = target
    container.title = target
    parent.appendChild(container)
    if (node.name !== 'Link') {
      appendCommentText(container, target.replace(/^<|>$/g, ''), url.from - offset, comments)
      return
    }
  } else if (formats[node.name]) {
    const [tag, className] = formats[node.name]
    container = document.createElement(tag)
    container.className = className
    parent.appendChild(container)
  } else if (node.name === 'Escape') {
    appendCommentText(parent, raw.slice(1), node.from + 1 - offset, comments)
    return
  } else if (node.name !== 'TableCell') {
    appendCommentText(parent, raw, node.from - offset, comments)
    return
  }
  let position = node.from
  const end = node.name === 'Link' ? node.getChildren('LinkMark')[1].from : node.to
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from >= end) break
    appendCommentText(container, text.slice(position - offset, child.from - offset), position - offset, comments)
    if (!['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'LinkTitle'].includes(child.name)
      && !(node.name === 'Link' && child.name === 'URL')) {
      renderTableInline(container, child, text, offset, comments)
    }
    position = child.to
  }
  appendCommentText(container, text.slice(position - offset, end - offset), position - offset, comments)
}

function tableCellNodes(row, cells) {
  // The Markdown tree omits empty cells. Keep their column slots when
  // matching the remaining syntax nodes to the parsed row.
  const nodes = row?.getChildren('TableCell') || []
  let index = 0
  return cells.map(cell => cell === '' ? null : nodes[index++])
}

// Stable across feature reconfiguration; each document owns its own value.
export const setTableWidths = StateEffect.define()
export const tableWidthsField = StateField.define({
  create: () => [],
  update(entries, tr) {
    let next = entries
    if (tr.docChanged) {
      next = entries.flatMap(entry => {
        let replaced = false
        tr.changes.iterChangedRanges((from, to) => {
          if (from <= entry.from && to >= entry.to) replaced = true
        })
        if (replaced) return []
        const from = tr.changes.mapPos(entry.from, 1)
        const to = tr.changes.mapPos(entry.to, -1)
        const parsed = parseMarkdownTable(stripCommentTags(tr.state.sliceDoc(from, to)))
        return parsed?.headers.length === entry.widths.length ? [{ ...entry, from, to }] : []
      })
    }
    for (const effect of tr.effects) {
      if (!effect.is(setTableWidths)) continue
      const { from, to, widths } = effect.value
      next = next.filter(entry => entry.from !== from)
      if (widths) next = [...next, { from, to, widths }]
    }
    return next
  },
})

class TableWidget extends WidgetType {
  constructor(text, node, resize = null, discussions = null) {
    super()
    this.text = text
    this.node = node
    this.resize = resize
    this.discussions = discussions
  }

  eq(other) {
    return this.text === other.text && this.resize?.from === other.resize?.from
      && this.resize?.to === other.resize?.to && this.resize?.widths === other.resize?.widths
      && Boolean(this.resize) === Boolean(other.resize)
      && this.discussions?.raw === other.discussions?.raw
      && this.discussions?.activeId === other.discussions?.activeId
      && this.discussions?.resolvedVisible === other.discussions?.resolvedVisible
      && this.discussions?.config === other.discussions?.config
  }
  ignoreEvent(event) { return Boolean(event.target?.closest?.('.cm-lp-column-resize, .cm-lp-table-controls, .cm-table-comment-marker, .cm-table-comments')) }

  commit(view) {
    return widths => view.dispatch({ effects: setTableWidths.of({ ...this.resize, widths }) })
  }

  updateDOM(dom, view) {
    const controller = tableResizeController(dom)
    if (dom.dataset.tableText !== this.text || dom._commentRaw !== this.discussions?.raw
      || dom._commentConfig !== this.discussions?.config || Boolean(controller) !== Boolean(this.resize)) return false
    controller?.update(this.resize.widths, this.commit(view))
    tableCommentsController(dom)?.sync(this.discussions?.activeId, this.discussions?.resolvedVisible)
    return true
  }

  destroy(dom) { tableResizeController(dom)?.destroy() }

  toDOM(view) {
    const parsed = parseMarkdownTable(this.text)
    if (!parsed) {
      const pre = document.createElement('pre')
      pre.textContent = this.text
      pre.className = 'cm-lp-table-fallback'
      return pre
    }

    const comments = this.discussions?.comments || []
    const cellEntries = []
    const table = document.createElement('table')
    table.className = 'cm-lp-table'

    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    const headers = tableCellNodes(this.node.getChild('TableHeader'), parsed.headers)
    const rows = this.node.getChildren('TableRow')
    parsed.headers.forEach((cell, i) => {
      const th = document.createElement('th')
      if (headers[i]) renderTableInline(th, headers[i], this.text, this.node.from, comments)
      const align = parsed.alignments[i] || 'left'
      if (align !== 'left') th.style.textAlign = align
      cellEntries.push({ cell: th, node: headers[i] && { from: headers[i].from - this.node.from, to: headers[i].to - this.node.from }, column: th.textContent || `Column ${i + 1}`, row: 0 })
      headerRow.appendChild(th)
    })
    thead.appendChild(headerRow)
    table.appendChild(thead)

    if (parsed.rows.length > 0) {
      const tbody = document.createElement('tbody')
      parsed.rows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr')
        const cells = tableCellNodes(rows[rowIndex], row)
        for (let i = 0; i < parsed.headers.length; i++) {
          const td = document.createElement('td')
          if (cells[i]) renderTableInline(td, cells[i], this.text, this.node.from, comments)
          const align = parsed.alignments[i] || 'left'
          if (align !== 'left') td.style.textAlign = align
          cellEntries.push({ cell: td, node: cells[i] && { from: cells[i].from - this.node.from, to: cells[i].to - this.node.from }, column: headerRow.cells[i].textContent || `Column ${i + 1}`, row: rowIndex + 1 })
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      })
      table.appendChild(tbody)
    }

    const wrapper = document.createElement('div')
    wrapper.className = 'cm-lp-table-wrap'
    wrapper.appendChild(table)
    wrapper.dataset.tableText = this.text
    wrapper._commentRaw = this.discussions?.raw
    wrapper._commentConfig = this.discussions?.config
    addTableComments(wrapper, table, view, this.discussions, cellEntries)
    if (this.resize) {
      addTableResizeControls(wrapper, table, view, this.resize.widths, this.commit(view))
    }
    return wrapper
  }
}

class ImageWidget extends WidgetType {
  constructor(src, absPath) {
    super()
    this.src = src
    this.absPath = absPath
  }

  eq(other) { return this.absPath === other.absPath }
  ignoreEvent() { return false }

  toDOM() {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-lp-image-wrap'

    const img = document.createElement('img')

    if (isRemoteUrl(this.absPath)) {
      img.src = this.absPath
      wrapper.appendChild(img)
    } else if (imageCache.has(this.absPath)) {
      img.src = imageCache.get(this.absPath)
      wrapper.appendChild(img)
    } else {
      const placeholder = document.createElement('span')
      placeholder.className = 'cm-lp-image-placeholder'
      placeholder.textContent = 'Loading image…'
      wrapper.appendChild(placeholder)

      const absPath = this.absPath
      readBinaryFile(absPath)
        .then(bytes => {
          const blob = new Blob([bytes], { type: getMimeType(absPath) })
          const dataUrl = URL.createObjectURL(blob)
          imageCache.set(absPath, dataUrl)
          img.src = dataUrl
          wrapper.appendChild(img)
          placeholder.remove()
        })
        .catch(() => {
          placeholder.textContent = 'Image not found'
        })
    }

    return wrapper
  }
}

function buildDecorations(view, isEnabled, getFilePath, ownedLinks = () => [], { resizableTables = () => false } = {}) {
  const enabled = isEnabled()
  const { state } = view

  const cursorLines = new Set()
  for (const range of state.selection.ranges) {
    const headLine = state.doc.lineAt(range.head).number
    const anchorLine = state.doc.lineAt(range.anchor).number
    for (let l = Math.min(headLine, anchorLine); l <= Math.max(headLine, anchorLine); l++) {
      cursorLines.add(l)
    }
  }

  const { from: vpFrom, to: vpTo } = view.viewport
  const start = Math.max(0, vpFrom - 500)
  const end = Math.min(state.doc.length, vpTo + 500)

  const decos = []
  const excludedLinks = ownedLinks(state)
  let quoteEnd = -1

  syntaxTree(state).iterate({
    from: start,
    to: end,
    enter(node) {
      const name = node.type.name
      const nFrom = node.from
      const nTo = node.to

      if (name.startsWith('ATXHeading')) {
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.type.name === 'HeaderMark') {
              decos.push(Decoration.mark({ class: 'cm-lp-heading-mark' }).range(child.from, child.to))
            }
          },
        })
        if (!enabled) return false
      }

      if (!enabled) return

      if (name === 'FencedCode' || name === 'CodeBlock') return false
      if (['Link', 'Autolink'].includes(name) && excludedLinks.some(link => link.from === nFrom && link.to === nTo)) return false

      const nodeLine = state.doc.lineAt(nFrom).number
      const onCursorLine = cursorLines.has(nodeLine)

      if (name === 'StrongEmphasis' && !onCursorLine) {
        let marks = []
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'EmphasisMark') {
              marks.push({ from: child.from, to: child.to })
            }
          },
        })
        if (marks.length >= 2) {
          decos.push(Decoration.replace({}).range(marks[0].from, marks[0].to))
          decos.push(Decoration.replace({}).range(marks[marks.length - 1].from, marks[marks.length - 1].to))
          decos.push(Decoration.mark({ class: 'cm-lp-bold' }).range(marks[0].to, marks[marks.length - 1].from))
        }
        return false
      }

      if (name === 'Emphasis' && !onCursorLine) {
        let marks = []
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'EmphasisMark') {
              marks.push({ from: child.from, to: child.to })
            }
          },
        })
        if (marks.length >= 2) {
          decos.push(Decoration.replace({}).range(marks[0].from, marks[0].to))
          decos.push(Decoration.replace({}).range(marks[marks.length - 1].from, marks[marks.length - 1].to))
          decos.push(Decoration.mark({ class: 'cm-lp-italic' }).range(marks[0].to, marks[marks.length - 1].from))
        }
        return false
      }

      if (name === 'Strikethrough' && !onCursorLine) {
        let marks = []
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'StrikethroughMark') {
              marks.push({ from: child.from, to: child.to })
            }
          },
        })
        if (marks.length >= 2) {
          decos.push(Decoration.replace({}).range(marks[0].from, marks[0].to))
          decos.push(Decoration.replace({}).range(marks[marks.length - 1].from, marks[marks.length - 1].to))
          decos.push(Decoration.mark({ class: 'cm-lp-strike' }).range(marks[0].to, marks[marks.length - 1].from))
        }
        return false
      }

      if (name === 'InlineCode' && !onCursorLine) {
        let marks = []
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'CodeMark') {
              marks.push({ from: child.from, to: child.to })
            }
          },
        })
        if (marks.length >= 2) {
          decos.push(Decoration.replace({}).range(marks[0].from, marks[0].to))
          decos.push(Decoration.replace({}).range(marks[marks.length - 1].from, marks[marks.length - 1].to))
        }
        return false
      }

      if (name === 'Link' && !onCursorLine) {
        let linkMarks = []
        let destination = null
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'LinkMark') {
              linkMarks.push({ from: child.from, to: child.to })
            }
            if (child.type.name === 'URL') {
              destination = markdownLinkDestination(state.sliceDoc(child.from, child.to))
            }
          },
        })
        if (linkMarks.length >= 1) {
          decos.push(Decoration.replace({}).range(linkMarks[0].from, linkMarks[0].to))
        }
        if (linkMarks.length >= 2) {
          decos.push(Decoration.replace({}).range(linkMarks[1].from, nTo))
          if (destination) {
            decos.push(Decoration.mark({ class: 'cm-lp-link' }).range(linkMarks[0].to, linkMarks[1].from))
          }
        }
        return false
      }

      if (name === 'Autolink' && !onCursorLine) {
        const marks = []
        let url = null
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'LinkMark') marks.push({ from: child.from, to: child.to })
            if (child.type.name === 'URL') url = { from: child.from, to: child.to }
          },
        })
        for (const mark of marks) decos.push(Decoration.replace({}).range(mark.from, mark.to))
        if (url && markdownLinkDestination(state.sliceDoc(url.from, url.to))) {
          decos.push(Decoration.mark({ class: 'cm-lp-link' }).range(url.from, url.to))
        }
        return false
      }

      if (name === 'URL' && !onCursorLine) {
        if (markdownLinkDestination(state.sliceDoc(nFrom, nTo))) {
          decos.push(Decoration.mark({ class: 'cm-lp-link' }).range(nFrom, nTo))
        }
        return false
      }

      if (name === 'Image' && !onCursorLine) {
        let imgUrl = null
        syntaxTree(state).iterate({
          from: nFrom, to: nTo,
          enter(child) {
            if (child.from < nFrom || child.to > nTo) return
            if (child.type.name === 'URL') {
              imgUrl = state.sliceDoc(child.from, child.to)
            }
          },
        })
        if (imgUrl && getFilePath) {
          const absPath = resolveImagePath(imgUrl, getFilePath())
          decos.push(Decoration.replace({ widget: new ImageWidget(imgUrl, absPath) }).range(nFrom, nTo))
        }
        return false
      }

      if (name === 'Blockquote' && nFrom >= quoteEnd) {
        // Scan each outer quote once. QuoteMark nodes also occur inside code
        // and inline nodes that the main preview traversal skips.
        quoteEnd = nTo
        node.node.cursor().iterate(child => {
          if (child.to < start || child.from > end) return false
          if (child.type.name !== 'QuoteMark') return
          const line = state.doc.lineAt(child.from)
          if (cursorLines.has(line.number)) return
          const next = state.sliceDoc(child.to, Math.min(child.to + 1, line.to))
          const hideEnd = child.to + (next === ' ' || next === '\t' ? 1 : 0)
          decos.push(Decoration.replace({}).range(child.from, hideEnd))
        })
        const startLine = state.doc.lineAt(Math.max(nFrom, start)).number
        const endLine = state.doc.lineAt(Math.min(nTo, end)).number
        for (let l = startLine; l <= endLine; l++) {
          if (cursorLines.has(l)) continue
          const lineStart = state.doc.line(l).from
          decos.push(Decoration.line({ class: 'cm-lp-blockquote-line' }).range(lineStart))
        }
      }

      if (name === 'HorizontalRule' && !onCursorLine) {
        decos.push(Decoration.replace({ widget: new HrWidget() }).range(nFrom, nTo))
        return false
      }

      if (name === 'Table') return false
    },
  })

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)

  const builder = new RangeSetBuilder()
  for (const d of decos) {
    builder.add(d.from, d.to, d.value)
  }
  return builder.finish()
}

function buildTableDecorations(state, isEnabled, resizableTables) {
  if (!isEnabled()) return Decoration.none

  const cursorLines = new Set()
  for (const range of state.selection.ranges) {
    const headLine = state.doc.lineAt(range.head).number
    const anchorLine = state.doc.lineAt(range.anchor).number
    for (let l = Math.min(headLine, anchorLine); l <= Math.max(headLine, anchorLine); l++) {
      cursorLines.add(l)
    }
  }

  const decos = []

  syntaxTree(state).iterate({
    enter(node) {
      const name = node.type.name
      if (name === 'FencedCode' || name === 'CodeBlock') return false

      if (name === 'Table') {
        const fromLine = state.doc.lineAt(node.from)
        const toLine = state.doc.lineAt(node.to > node.from ? node.to - 1 : node.to)
        let cursorInTable = false
        for (let l = fromLine.number; l <= toLine.number; l++) {
          if (cursorLines.has(l)) { cursorInTable = true; break }
        }
        if (!cursorInTable) {
          const raw = state.sliceDoc(node.from, node.to)
          const text = stripCommentTags(raw)
          // The widget owns its DOM, so editor tag decorations cannot hide tags
          // inside it. Parse the visible text again to keep cell/node offsets
          // correct, including pipes and newlines in comment attributes.
          const tableNode = text === raw ? node.node
            : state.facet(language)?.parser.parse(text).topNode.getChild('Table')
          if (!tableNode) return false
          decos.push(
            Decoration.replace({ widget: new TableWidget(text, tableNode, resizableTables() ? {
              from: node.from, to: node.to,
              widths: state.field(tableWidthsField).find(entry => entry.from === node.from && entry.to === node.to)?.widths || null,
            } : null, {
              raw, comments: tableComments(raw),
              activeId: state.field(commentTagField, false)?.activeId,
              resolvedVisible: state.field(commentTagField, false)?.resolvedVisible,
              config: state.facet(commentWidgetConfig),
            }), block: true })
              .range(fromLine.from, toLine.to)
          )
        }
        return false
      }
    },
  })

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)

  const builder = new RangeSetBuilder()
  for (const d of decos) {
    builder.add(d.from, d.to, d.value)
  }
  return builder.finish()
}

function navigateIntoTable(view, direction, isEnabled) {
  if (!isEnabled()) return false

  const { state } = view
  const pos = state.selection.main.head

  let insideTable = false
  syntaxTree(state).iterate({
    from: pos, to: pos,
    enter(node) {
      if (node.type.name === 'Table') { insideTable = true; return false }
    },
  })
  if (insideTable) return false

  const line = state.doc.lineAt(pos)

  if (direction === 'down') {
    const nextPos = line.to + 1
    if (nextPos >= state.doc.length) return false

    let tableFrom = null
    syntaxTree(state).iterate({
      from: nextPos, to: nextPos,
      enter(node) {
        if (node.type.name === 'Table') { tableFrom = node.from; return false }
      },
    })
    if (tableFrom !== null) {
      view.dispatch({ selection: { anchor: tableFrom } })
      return true
    }
  } else {
    if (line.from === 0) return false
    const prevPos = line.from - 1

    let tableTo = null
    syntaxTree(state).iterate({
      from: prevPos, to: prevPos,
      enter(node) {
        if (node.type.name === 'Table') { tableTo = node.to; return false }
      },
    })
    if (tableTo !== null) {
      const toLine = state.doc.lineAt(tableTo > 0 ? tableTo - 1 : tableTo)
      view.dispatch({ selection: { anchor: toLine.to } })
      return true
    }
  }

  return false
}

const livePreviewTheme = EditorView.baseTheme({
  '.cm-lp-bold': {
    fontWeight: '700',
    color: 'var(--ink-strong)',
  },
  '.cm-lp-italic': {
    fontStyle: 'italic',
    color: 'var(--ink-emphasis)',
  },
  '.cm-lp-strike': {
    textDecoration: 'line-through',
  },
  '.cm-lp-code': {
    fontFamily: 'var(--font-mono)',
    backgroundColor: 'var(--inline-code-bg)',
    color: 'var(--code)',
  },
  '.cm-lp-link': {
    color: 'var(--color-accent)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textUnderlineOffset: '2px',
  },
  '.cm-lp-link:hover': {
    textDecorationThickness: '2px',
  },
  '.cm-lp-heading-mark': {
    color: 'var(--editor-heading-1)',
    fontSize: '1em',
    fontWeight: '700',
  },
  '.cm-lp-heading-mark > span': {
    color: 'var(--editor-heading-1)',
    fontWeight: '700',
  },
  '.cm-lp-blockquote-line': {
    borderLeft: '2px solid var(--color-rule)',
    paddingLeft: '8px',
  },
  '.cm-lp-hr': {
    border: 'none',
    borderTop: '1px solid var(--color-rule)',
    margin: '8px 0',
    display: 'block',
  },
  '.cm-lp-table-wrap': {
    padding: '4px 0',
    overflowX: 'auto',
    display: 'block',
  },
  '.cm-lp-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: 'var(--editor-size)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-ink)',
  },
  '.cm-lp-table td': {
    padding: '4px 12px',
    borderBottom: '1px solid var(--color-rule)',
    color: 'var(--color-ink-2)',
  },
  '.cm-lp-table th': {
    position: 'relative',
    fontWeight: '600',
    backgroundColor: 'var(--color-chrome-mid)',
    borderBottom: '2px solid var(--color-rule)',
    padding: '6px 12px',
    textAlign: 'left',
    color: 'var(--color-ink)',
  },
  '.cm-lp-table-sized th, .cm-lp-table-sized td': { overflowWrap: 'anywhere', whiteSpace: 'normal' },
  '.cm-lp-column-resize': {
    position: 'absolute', right: '-4px', top: '0', bottom: '0', width: '9px',
    zIndex: '1', cursor: 'col-resize', touchAction: 'none', outline: 'none',
  },
  '.cm-lp-column-resize::after': {
    content: '""', position: 'absolute', left: '4px', top: '4px', bottom: '4px',
    width: '1px', backgroundColor: 'var(--color-rule)', pointerEvents: 'none',
  },
  '.cm-lp-column-resize:hover::after, .cm-lp-column-resize:focus-visible::after': {
    width: '2px', backgroundColor: 'var(--color-accent)',
  },
  '.cm-lp-column-resize:focus-visible::after': {
    outline: '1px solid var(--color-accent)', outlineOffset: '2px',
  },
  '.cm-lp-table-controls': { height: '22px', display: 'flex', justifyContent: 'flex-end' },
  '.cm-lp-table-controls button': {
    fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-ink-3)', cursor: 'pointer',
  },
  '.cm-lp-table-controls button:hover': { color: 'var(--color-ink)' },
  '.cm-lp-table-controls button:focus-visible': { outline: '1px solid var(--color-accent)' },
  '.cm-lp-table-resizing, .cm-lp-table-resizing *': { cursor: 'col-resize', userSelect: 'none' },
  '.cm-lp-table tbody tr:hover': {
    backgroundColor: 'var(--color-line-soft)',
  },
  '.cm-lp-image-wrap': {
    display: 'block',
    margin: '4px 0',
    lineHeight: '0',
  },
  '.cm-lp-image-wrap img': {
    maxWidth: '100%',
    maxHeight: '400px',
    borderRadius: '4px',
    display: 'block',
  },
  '.cm-lp-image-placeholder': {
    display: 'block',
    padding: '12px',
    color: 'var(--color-ink-4)',
    fontSize: 'var(--editor-size)',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.4',
  },
})

export function livePreviewExtension(isEnabled, getFilePath, ownedLinks = () => [], { resizableTables = () => false } = {}) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view
        this._enabled = isEnabled()
        this.decorations = buildDecorations(view, isEnabled, getFilePath, ownedLinks)
      }

      destroy() {
        this.view.dom.querySelectorAll('.cm-lp-table-wrap').forEach(dom => tableResizeController(dom)?.cancel())
      }

      update(update) {
        if (update.docChanged) this.destroy()
        const nowEnabled = isEnabled()
        if (
          nowEnabled !== this._enabled ||
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          syntaxTree(update.state) !== syntaxTree(update.startState) ||
          update.startState.facet(EditorView.darkTheme) !== update.state.facet(EditorView.darkTheme)
        ) {
          this._enabled = nowEnabled
          this.decorations = buildDecorations(update.view, isEnabled, getFilePath, ownedLinks)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  let tableEnabled = isEnabled()
  const tableField = StateField.define({
    create(state) {
      return buildTableDecorations(state, isEnabled, resizableTables)
    },
    update(value, tr) {
      const nowEnabled = isEnabled()
      if (
        nowEnabled !== tableEnabled ||
        tr.docChanged ||
        tr.effects.some(effect => effect.is(setTableWidths) || effect.is(setActiveComment) || effect.is(setResolvedCommentsVisible)) ||
        tr.selection ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ) {
        tableEnabled = nowEnabled
        return buildTableDecorations(tr.state, isEnabled, resizableTables)
      }
      return value
    },
    provide: f => [
      EditorView.decorations.from(f),
      tableCommentIds.compute([f], state => {
        const ids = []
        for (let iter = state.field(f).iter(); iter.value; iter.next()) {
          const data = iter.value.spec.widget?.discussions
          if (data?.config) ids.push(...data.comments.map(comment => comment.id))
        }
        return ids
      }),
    ],
  })

  const tableNav = Prec.high(keymap.of([
    { key: 'ArrowDown', run: view => navigateIntoTable(view, 'down', isEnabled) },
    { key: 'ArrowUp', run: view => navigateIntoTable(view, 'up', isEnabled) },
  ]))

  return [tableWidthsField, plugin, tableField, tableNav, livePreviewTheme]
}

export { buildDecorations as _buildDecorations, parseMarkdownTable as _parseMarkdownTable, resolveImagePath as _resolveImagePath }
