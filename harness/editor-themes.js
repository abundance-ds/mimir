// editor-themes harness — grid page (no ?theme) and cell page (?theme=<name>)

const params = new URLSearchParams(location.search)
const theme = params.get('theme')

// Mirrors DARK_THEMES in src/stores/settings.js
const DARK_THEMES = ['slate', 'monokai', 'dracula', 'zenith', 'synthwave']

const ALL_THEMES = ['parchment', 'studio', 'glacier', 'slate', 'monokai', 'dracula', 'zenith', 'synthwave']

const SAMPLE_DOC = `# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

This paragraph contains **bold**, *italic*, ***bold italic***, ~~strikethrough~~, \`inline code\`, a [link](https://example.com), a bare URL https://example.com/docs, and an image ![diagram](missing.png). These inline styles let you check every token colour at a glance.

- First item
  - Nested item one
  - Nested item two
- Second item
- Third item

1. Step one
2. Step two
3. Step three

- [x] Review colour contrast ratios
- [ ] Adjust code-block backgrounds

> A blockquote with **bold** emphasis inside it. Blockquotes should stand apart from surrounding text and carry a visible left border.

\`\`\`js
function greet(name) {
  const message = \`Hello, \${name}!\`
  console.log(message)
  return message
}
\`\`\`

\`\`\`python
def summarise(records):
    total = sum(r["value"] for r in records)
    return {"count": len(records), "total": total}
\`\`\`

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
for f in src/*.js; do
  wc -l "$f"
done
\`\`\`

\`\`\`
Plain fenced block with no language tag.
It should use the default monospace style
without syntax highlighting.
\`\`\`

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| Alpha    | 100      | Active   |
| Bravo    | 250      | Paused   |
| Charlie  | 42       | Active   |

---

Configuration files often grow over time. A settings object that began as five fields can reach forty within a year, especially when each deployment environment adds its own overrides. Keeping the schema documented and the defaults explicit prevents drift. Reviewers can then compare a change against the canonical shape instead of guessing which values are required and which are optional.
`

if (theme) {
  // ---- Cell page ----
  initCell(theme)
} else {
  // ---- Grid page ----
  initGrid()
}

// ---------------------------------------------------------------------------
// Cell page: mounts the real CodeMirror editor with the given theme
// ---------------------------------------------------------------------------

async function initCell(themeName) {
  document.documentElement.setAttribute('data-theme', themeName)

  // Import stylesheets (order matters)
  await import('../src/shared/styles/fonts.css')
  await import('../src/shared/styles/themes.css')
  await import('../src/shared/styles/app.css')
  await import('../src/shared/styles/editor-content.css')

  const { createEditor } = await import('../src/editor/codemirror/core.js')
  const { livePreviewExtension } = await import('../src/editor/codemirror/livePreview.js')
  const { taskCheckboxExtension } = await import('../src/editor/codemirror/taskCheckboxes.js')
  const { editorTypographyVars } = await import('../src/shared/fonts.js')

  const preview = params.get('preview') === '1'
  const size = parseInt(params.get('size') || '14', 10)
  const isDark = DARK_THEMES.includes(themeName)

  const wrapper = document.getElementById('editor-root')

  // Apply typography custom properties (mirrors EditorSurface.vue .editor-wrap)
  const vars = editorTypographyVars({ fontSize: size, zoom: 1, fontKey: 'mono', dark: isDark })
  for (const [key, val] of Object.entries(vars)) {
    wrapper.style.setProperty(key, val)
  }

  const view = createEditor({
    parent: wrapper,
    doc: SAMPLE_DOC,
    path: 'sample.md',
    extensions: [
      ...livePreviewExtension(() => preview, () => 'sample.md'),
      ...taskCheckboxExtension(() => preview),
    ],
    initialSettings: { wordWrap: true, spellCheck: false, lineNumbers: false, isDark },
  })

  // Load Commit Mono before measuring (mirrors EditorSurface.vue)
  if (vars['--font-mono'].startsWith('"Commit Mono"') && document.fonts?.load) {
    const descriptor = `${vars['--editor-font-weight']} ${vars['--editor-size']} "Commit Mono"`
    try {
      await document.fonts.load(descriptor)
    } catch {
      // Fallback stack remains usable
    }
  }
  view.requestMeasure()
}

// ---------------------------------------------------------------------------
// Grid page: shows all eight themes in iframes
// ---------------------------------------------------------------------------

function initGrid() {
  const app = document.getElementById('app')

  // Controls
  const bar = document.createElement('div')
  bar.className = 'grid-bar'

  let preview = parseInt(params.get('preview') || '0', 10)
  let size = parseInt(params.get('size') || '14', 10)

  // Raw / Live Preview toggle
  const previewLabel = document.createElement('label')
  previewLabel.className = 'grid-control'
  previewLabel.textContent = 'Preview '
  const previewToggle = document.createElement('select')
  for (const [val, label] of [['0', 'Raw'], ['1', 'Live Preview']]) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    if (parseInt(val) === preview) opt.selected = true
    previewToggle.appendChild(opt)
  }
  previewLabel.appendChild(previewToggle)
  bar.appendChild(previewLabel)

  // Font size
  const sizeLabel = document.createElement('label')
  sizeLabel.className = 'grid-control'
  sizeLabel.textContent = 'Size '
  const sizeSelect = document.createElement('select')
  for (const s of [12, 13, 14, 16]) {
    const opt = document.createElement('option')
    opt.value = String(s)
    opt.textContent = s + 'px'
    if (s === size) opt.selected = true
    sizeSelect.appendChild(opt)
  }
  sizeLabel.appendChild(sizeSelect)
  bar.appendChild(sizeLabel)

  app.appendChild(bar)

  // Grid
  const grid = document.createElement('div')
  grid.className = 'grid-container'

  const iframes = []

  for (const name of ALL_THEMES) {
    const cell = document.createElement('div')
    cell.className = 'grid-cell'

    const caption = document.createElement('div')
    caption.className = 'grid-caption'
    caption.textContent = name
    cell.appendChild(caption)

    const iframe = document.createElement('iframe')
    iframe.src = cellUrl(name, preview, size)
    iframe.className = 'grid-iframe'
    cell.appendChild(iframe)

    grid.appendChild(cell)
    iframes.push({ name, iframe })
  }

  app.appendChild(grid)

  // Update all iframes when controls change
  function refresh() {
    preview = parseInt(previewToggle.value, 10)
    size = parseInt(sizeSelect.value, 10)
    for (const { name, iframe } of iframes) {
      iframe.src = cellUrl(name, preview, size)
    }
  }

  previewToggle.addEventListener('change', refresh)
  sizeSelect.addEventListener('change', refresh)
}

function cellUrl(name, preview, size) {
  return `editor-themes.html?theme=${name}&preview=${preview}&size=${size}`
}
