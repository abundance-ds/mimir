export function buildCommentsPrompt({ comments = [], filePath = '', focusId = null, focusLine = null } = {}) {
  if (!comments.length) {
    return 'No inline <comment> annotations are present in the active editor file.'
  }

  const active = comments.find(c => c.id === focusId) || comments[0]
  const target = filePath ? `@${filePath}` : 'the current unsaved editor document'
  const count = comments.length
  const line = focusLine ? ` near line ${focusLine}` : ''
  const focusText = active?.text ? `: ${active.text}` : '.'
  const focus = active ? ` Focus first on ${active.id}${line}${focusText}` : ''

  return `Please address the ${count} inline <comment> annotation${count === 1 ? '' : 's'} in ${target}. Read the file directly so you see the pseudo-XML comments in context. When a comment is resolved, remove the <comment> wrapper/replies and leave the anchored text in the file.${focus}`
}
