// Shared by the workbench, standalone Editor, and local-app SDK documents.
export const manualTextInputAttributes = Object.freeze({
  autocorrect: 'off',
  autocapitalize: 'off',
  autocomplete: 'off',
  writingsuggestions: 'false',
  spellcheck: 'false',
})

export function applyManualTextInput(element) {
  for (const [name, value] of Object.entries(manualTextInputAttributes)) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value)
  }
}

export function installTextInputPolicy(doc = document) {
  const selector = 'input, textarea, [contenteditable], form'
  function visit(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return
    if (root.matches?.(selector)) applyManualTextInput(root)
    for (const element of root.querySelectorAll(selector)) applyManualTextInput(element)
  }
  visit(doc)
  const onFocus = event => {
    if (event.target.matches?.(selector)) applyManualTextInput(event.target)
  }
  doc.addEventListener('focusin', onFocus, true)
  const observer = new doc.defaultView.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.matches(selector)) applyManualTextInput(record.target)
      } else for (const node of record.addedNodes) visit(node)
    }
  })
  observer.observe(doc, { subtree: true, childList: true, attributes: true,
    attributeFilter: [...Object.keys(manualTextInputAttributes), 'contenteditable'],
  })
  return () => {
    observer.disconnect()
    doc.removeEventListener('focusin', onFocus, true)
  }
}
