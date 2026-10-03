import '../src/shared/styles/app.css'
import { createApp, h, onMounted, shallowRef, ref } from 'vue'
import { createEditor, editorInputAttributesExtension, spellcheckCompartment } from '../src/editor/codemirror/core.js'
import { useSpellingContextMenu } from '../src/editor/composables/useSpellingContextMenu.js'
import EditorContextMenu from '../src/editor/components/workspace/EditorContextMenu.vue'
import { installTextInputPolicy } from '../src/shared/textInputPolicy.js'

document.documentElement.dataset.theme = 'parchment'
installTextInputPolicy()
// A fixed provider makes visual and interaction checks repeatable. This harness
// does not establish native macOS spelling-service or popup verification.
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  if (command === 'spell_check') return [...args.text.matchAll(/\b(?:mispelled|speling)\b/g)].map(match => ({ from: match.index, to: match.index + match[0].length }))
  if (command === 'spell_suggest') return ({ mispelled: ['misspelled'], speling: ['spelling'] })[args.word] || []
  throw new Error(`Unexpected harness command: ${command}`)
} }

createApp({
  components: { EditorContextMenu },
  setup() {
    const view = shallowRef(null)
    const enabled = ref(true)
    const { menu, open, keydown } = useSpellingContextMenu(() => view.value)
    onMounted(() => {
      view.value = createEditor({ parent: document.querySelector('#editor'),
        path: 'spelling.md', initialSettings: { spellCheck: true },
        doc: '# Spelling check\n\nA mispelled word and a speling error.\n\n😀 mispelled — Straße — café\n\n`mispelled` and https://mispelled.test must have no underline.\n\nMove the cursor to the end of a marked word. Right-click or press Shift+F10 for suggestions.',
      })
      window.spellingHarness = { get view() { return view.value }, get menu() { return menu } }
    })
    function toggle() {
      enabled.value = !enabled.value
      view.value.dispatch({ effects: spellcheckCompartment.reconfigure(editorInputAttributesExtension(enabled.value)) })
    }
    return () => h('main', [
      h('header', [h('strong', 'Spelling verification'), h('button', { onClick: toggle }, `Spell check ${enabled.value ? 'on' : 'off'}`),
        h('input', { 'aria-label': 'Search', placeholder: 'Ordinary text input' })]),
      h('p', 'Fixed spelling results. Native macOS verification is separate.'),
      h('div', { id: 'editor', onContextmenu: open, onKeydown: keydown }),
      h(EditorContextMenu, { visible: menu.show, x: menu.x, y: menu.y, position: menu.position,
        hasSelection: menu.hasSelection, view: view.value, spellcheckEnabled: enabled.value,
        aiEnabled: false, allowComments: false, onClose: () => { menu.show = false } }),
    ])
  },
}).mount('#app')
