import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import '../src/shared/styles/editor-content.css'
import { createPinia, setActivePinia } from 'pinia'
import { createEditor } from '../src/editor/codemirror/core.js'
import { editorTypographyVars } from '../src/shared/fonts.js'
import { livePreviewExtension } from '../src/editor/codemirror/livePreview.js'
import { commentsExtension } from '../src/editor/codemirror/comments.js'
import { useCommentMutations } from '../src/editor/composables/useCommentMutations.js'

const theme = new URLSearchParams(location.search).get('theme') || 'parchment'
document.documentElement.dataset.theme = theme
const parent = document.querySelector('#editor')
for (const [key, value] of Object.entries(editorTypographyVars({ fontSize: 14, zoom: 1, fontKey: 'mono', dark: theme === 'slate' }))) parent.style.setProperty(key, value)
setActivePinia(createPinia())
let view
const mutations = useCommentMutations({ value: { getView: () => view } })
const doc = `# Monthly costs

| Who | Item | Monthly | 12 months |
| --- | --- | ---: | ---: |
| General | <comment id="workspace" author="user" text="Confirm the number of seats.">**Workspace Standard** × 3</comment> | €58 | €696 |
| | <comment id="github-plan" author="user" text="Do we need the Team plan?">GitHub Team</comment> × <comment id="github-seats" author="user" text="One account may no longer be needed.">4</comment> | €18 | €216 |
| | <comment id="slack" author="user" text="Annual billing is confirmed." status="resolved">Slack Pro × 8</comment> | €75 | €900 |
| Paul | Codex / ChatGPT | €220 | €2,640 |
| **TOTAL** | | **€371** | **€4,452** |

Notes after the table.
Check this line with the mouse and arrow keys.
Check the next line too.
`
view = createEditor({
  parent, doc, path: 'costs.md',
  extensions: [
    commentsExtension({ onCommentAction: ({ type, id, text, replyId }) => {
      if (type === 'reply') return mutations.addReply(id, text)
      if (type === 'save-text') return mutations.updateText(id, text)
      if (type === 'update-reply') return mutations.updateReply(id, replyId, text)
      if (type === 'delete-reply') return mutations.deleteReply(id, replyId)
      if (type === 'strip-all') return mutations.clearAll()
      return mutations[type]?.(id) || { ok: false, error: 'This harness supports local comment actions only.' }
    } }),
    livePreviewExtension(() => true, () => 'costs.md', () => [], { resizableTables: () => true }),
  ],
  initialSettings: { wordWrap: true, spellCheck: false, lineNumbers: false, isDark: theme === 'slate' },
})
view.dispatch({ selection: { anchor: doc.length } })
await document.fonts.ready
view.requestMeasure()
window.tableCommentsView = view
