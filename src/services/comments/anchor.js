// Snap a comment anchor away from Markdown block markers.
//
// A <comment> open tag inserted before a line's block marker removes the
// marker from the line start, so the line stops being a heading, list item,
// task, or quote and its formatting collapses. Snapping moves the anchor
// start past indent and block markers, and moves an anchor end that stops at
// a line start or inside a marker prefix back to the end of the previous
// content line. Interior lines of a multi-line anchor keep their own markers
// and are unaffected.

// Indent, nested blockquote markers, then one optional list/task or ATX
// heading marker. Mirrors the CommonMark line-start grammar Lezer uses.
const BLOCK_MARKER_RE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/

export function blockMarkerEnd(lineText) {
  return BLOCK_MARKER_RE.exec(lineText)[0].length
}

function lineBoundsAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1
  let end = text.indexOf('\n', start)
  if (end === -1) end = text.length
  return { start, end }
}

function contentStartAt(text, pos) {
  const { start, end } = lineBoundsAt(text, pos)
  return start + blockMarkerEnd(text.slice(start, end))
}

/**
 * Returns the snapped `{ from, to }` anchor range, or `null` when nothing
 * anchorable remains (for example a selection that covers only a marker).
 */
export function snapCommentAnchor(text, from, to) {
  let start = Math.max(0, Math.min(from, text.length))
  let end = Math.max(start, Math.min(to, text.length))

  const startContent = contentStartAt(text, start)
  if (start < startContent) start = Math.min(startContent, end)

  while (end > start) {
    const endLineStart = text.lastIndexOf('\n', end - 1) + 1
    if (end > contentStartAt(text, end)) break
    // The end sits at a line start or inside that line's marker prefix:
    // retreat to the end of the previous line and re-check.
    end = endLineStart - 1
    if (end < 0) end = 0
  }

  if (start >= end) return null
  return { from: start, to: end }
}
