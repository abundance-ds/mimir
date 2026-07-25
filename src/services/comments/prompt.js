export function buildCommentsPrompt({ comments = [], filePath = '', focusId = null, focusLine = null } = {}) {
  if (!comments.length) {
    return 'No inline <comment> annotations are present in the active editor file.'
  }

  const active = comments.find(c => c.id === focusId) || comments[0]
  const target = filePath ? `"${filePath}"` : '"@editor"'
  const count = comments.length
  const line = focusLine ? ` near line ${focusLine}` : ''
  const focusText = active?.text ? `: ${active.text}` : '.'
  const focus = active ? ` Focus first on ${active.id}${line}${focusText}` : ''

  return `Please address the ${count} inline <comment> annotation${count === 1 ? '' : 's'} in ${target}. Read that target with show_comments enabled so you see the canonical pseudo-XML threads in context. Preserve every <comment> wrapper, <reply>, and status attribute; use comment_reply to report what you changed, and leave resolve/reopen to the review UI.${focus}`
}
