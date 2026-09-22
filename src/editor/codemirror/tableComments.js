import { parseCommentTags } from '../../services/comments/parser.js'
import { setActiveComment } from './comments.js'

const controllers = new WeakMap()
export const tableCommentsController = dom => controllers.get(dom)

export function tableComments(raw) {
  const comments = parseCommentTags(raw).comments
  let removed = 0
  return comments.map(comment => {
    const from = comment.tagFrom - removed
    const to = from + comment.anchorText.length
    removed += comment.tagTo - comment.tagFrom - comment.anchorText.length
    return { ...comment, from, to }
  })
}

// Source offsets let emphasis, links, and repeated words retain exact anchors.
export function appendCommentText(parent, value, from, comments) {
  const to = from + value.length
  const cuts = new Set([from, to])
  for (const comment of comments) {
    if (comment.from < to && comment.to > from) {
      cuts.add(Math.max(from, comment.from))
      cuts.add(Math.min(to, comment.to))
    }
  }
  const positions = [...cuts].sort((a, b) => a - b)
  for (let i = 1; i < positions.length; i++) {
    const start = positions[i - 1], end = positions[i]
    const anchor = comments.find(comment => comment.from < end && comment.to > start)
    const text = document.createTextNode(value.slice(start - from, end - from))
    if (!anchor) parent.append(text)
    else {
      const mark = document.createElement('span')
      mark.dataset.tableCommentAnchor = anchor.id
      mark.dataset.resolved = String(anchor.status === 'resolved')
      mark.append(text)
      parent.append(mark)
    }
  }
}

export function addTableComments(wrapper, table, view, data, cellEntries) {
  if (!data?.comments.length || !data.config) return
  const { comments, config } = data
  const state = comments.map(comment => config.tables.get(comment.id)).find(Boolean)
    || { open: false, resolved: Boolean(data.resolvedVisible), globalResolved: data.resolvedVisible, activeId: null }
  for (const comment of comments) config.tables.set(comment.id, state)
  const panel = document.createElement('section')
  panel.className = 'cm-table-comments'
  panel.contentEditable = 'false'
  panel.setAttribute('aria-label', 'Table comments')
  const toolbar = document.createElement('div')
  toolbar.className = 'cm-table-comment-toolbar'
  const list = document.createElement('div')
  list.className = 'cm-table-comment-list'
  const activeCount = comments.filter(c => c.status !== 'resolved').length
  const resolvedCount = comments.length - activeCount
  const markers = []
  const entries = new Map()
  const labels = new Map()
  function button(label, className, action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = label
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation() })
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action() })
    button.addEventListener('keydown', event => event.stopPropagation())
    return button
  }
  const toggle = button(`Comments (${activeCount})`, 'cm-table-comment-toggle', () => {
    state.open = !state.open
    refresh()
  })
  toolbar.append(toggle)
  let resolvedToggle
  if (resolvedCount) {
    resolvedToggle = button('', 'cm-table-comment-resolved', () => {
      state.resolved = !state.resolved
      if (state.resolved) state.open = true
      refresh()
    })
    toolbar.append(resolvedToggle)
  }
  function select(id, reveal = false) {
    state.activeId = id
    if (reveal) {
      state.open = true
      if (comments.find(c => c.id === id)?.status === 'resolved') state.resolved = true
    }
    refresh()
  }
  function activate(id) {
    select(id, true)
    view.dispatch({ effects: setActiveComment.of(id) })
    config.onCommentClick?.(id)
  }
  for (const { cell, node, column, row } of cellEntries) {
    if (!node) continue
    const matched = comments.filter(c => c.from < node.to && c.to > node.from)
    if (!matched.length) continue
    for (const comment of matched) {
      const location = `${column}, ${row === 0 ? 'header' : `row ${row}`}`
      const rendered = [...cell.querySelectorAll('[data-table-comment-anchor]')]
        .filter(mark => mark.dataset.tableCommentAnchor === comment.id).map(mark => mark.textContent).join('')
      const excerpt = (rendered || comment.anchorText).replace(/\s+/g, ' ').trim().slice(0, 100)
      if (!labels.has(comment.id)) labels.set(comment.id, `${location}: ${excerpt}`)
    }
    const marker = button('', 'cm-table-comment-marker', () => {
      const visible = matched.filter(c => state.resolved || c.status !== 'resolved')
      if (!visible.length) return
      activate(visible[0].id)
      entries.get(visible[0].id)?.scrollIntoView?.({ block: 'nearest' })
      entries.get(visible[0].id)?.querySelector('button')?.focus({ preventScroll: true })
    })
    markers.push({ marker, matched, column, row })
    cell.append(marker)
  }
  for (const comment of comments) {
    const entry = document.createElement('div')
    entry.className = 'cm-table-comment-entry'
    entry.dataset.threadId = comment.id
    const anchor = button(labels.get(comment.id) || comment.anchorText.slice(0, 100), 'cm-table-comment-location', () => {
      activate(comment.id)
      const mark = [...table.querySelectorAll('[data-table-comment-anchor]')].find(el => el.dataset.tableCommentAnchor === comment.id)
      mark?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
    entry.append(anchor, config.render(comment, state.activeId, view, id => select(id, true)))
    // Comment widgets stop bubbling their own events. Capture selection here
    // without moving CodeMirror's text selection or rebuilding the composer.
    entry.addEventListener('click', () => select(comment.id, true), true)
    entries.set(comment.id, entry)
    list.append(entry)
  }
  function refresh() {
    toggle.setAttribute('aria-expanded', String(state.open))
    list.hidden = !state.open
    if (resolvedToggle) {
      resolvedToggle.textContent = state.resolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`
      resolvedToggle.setAttribute('aria-pressed', String(state.resolved))
    }
    for (const comment of comments) {
      const entry = entries.get(comment.id)
      if (!entry) continue
      entry.hidden = comment.status === 'resolved' && !state.resolved
      entry.classList.toggle('is-active', state.activeId === comment.id)
      entry.querySelector('.cm-comment-block')?.classList.toggle('is-active', state.activeId === comment.id)
    }
    for (const { marker, matched, column, row } of markers) {
      const count = matched.filter(c => state.resolved || c.status !== 'resolved').length
      marker.hidden = count === 0
      marker.textContent = count ? `${count} ${count === 1 ? 'comment' : 'comments'}` : ''
      marker.setAttribute('aria-label', `${count} ${count === 1 ? 'comment' : 'comments'} in ${column}, ${row === 0 ? 'header' : `row ${row}`}`)
      marker.setAttribute('aria-expanded', String(state.open))
    }
    for (const mark of table.querySelectorAll('[data-table-comment-anchor]')) {
      const visible = mark.dataset.resolved !== 'true' || state.resolved
      mark.classList.toggle('cm-comment-range', visible)
      mark.classList.toggle('cm-comment-range-active', visible && mark.dataset.tableCommentAnchor === state.activeId)
    }
    view.requestMeasure()
  }
  panel.addEventListener('mousedown', event => event.stopPropagation())
  panel.addEventListener('click', event => event.stopPropagation())
  panel.addEventListener('keydown', event => event.stopPropagation())
  panel.addEventListener('input', () => view.requestMeasure())
  panel.addEventListener('click', () => view.requestMeasure(), true)
  panel.append(toolbar, list)
  wrapper.append(panel)
  const sync = (id, resolvedVisible) => {
    if (resolvedVisible !== state.globalResolved) {
      state.globalResolved = resolvedVisible
      state.resolved = Boolean(resolvedVisible)
      if (resolvedVisible) state.open = true
    }
    const ownId = comments.some(comment => comment.id === id) ? id : null
    select(ownId, Boolean(ownId && ownId !== state.activeId))
  }
  controllers.set(wrapper, { sync })
  sync(data.activeId, data.resolvedVisible)
}
