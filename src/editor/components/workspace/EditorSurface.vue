<template>
  <div
    class="editor-wrap flex-1 min-w-0 flex bg-surface relative overflow-hidden"
    :class="showBorder ? 'border-r border-rule-light' : ''"
    :style="wrapperStyle"
  >
    <div ref="cmHost" class="flex-1 min-w-0" @contextmenu.prevent="onContextMenu"></div>
    <EditorContextMenu
      :visible="ctxMenu.show"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :has-selection="ctxMenu.hasSelection"
      :view="view"
      :spellcheck-enabled="settings.editorSpellCheck"
      @close="ctxMenu.show = false"
      @comment="emit('comment')"
      @ask-agent="emit('ask-agent')"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, shallowRef } from 'vue'
import { EditorView } from '@codemirror/view'
import { undo, redo, selectAll } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { createEditor, darkModeCompartment, editorInputAttributesExtension, languageCompartment, languageExtensionForPath, wrapCompartment, spellcheckCompartment } from '../../codemirror/core.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { fontFamilyForKey } from '../../../shared/fonts.js'
import * as fmt from '../../codemirror/formatting.js'
import EditorContextMenu from './EditorContextMenu.vue'

const props = defineProps({
  content: { type: String, default: '' },
  path: { type: String, default: '' },
  zoomLevel: { type: Number, default: 100 },
  maxWidth: { type: String, default: '' },
  showBorder: { type: Boolean, default: false },
  extensions: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'change',
  'selection-change',
  'cursor',
  'selection-command',
  'format',
  'comment',
  'ask-agent',
  'active-formats',
])

// ── Settings ──
const settings = useSettingsStore()

const cmHost = ref(null)
const view = shallowRef(null)
let applyingExternalContent = false

const ctxMenu = reactive({ show: false, x: 0, y: 0, hasSelection: false })
function onContextMenu(e) {
  if (!view.value) return
  const sel = view.value.state.selection.main
  ctxMenu.hasSelection = sel.from !== sel.to
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.show = true
}

defineExpose({
  getContent() {
    return view.value?.state.doc.toString() ?? ''
  },
  hasFocus() {
    return Boolean(view.value?.hasFocus)
  },
  replaceRange(from, to, text) {
    if (!view.value) return
    view.value.dispatch({
      changes: { from, to, insert: text },
    })
  },
  getCursor() {
    if (!view.value) return null
    const sel = view.value.state.selection.main
    const line = view.value.state.doc.lineAt(sel.head)
    return {
      offset: sel.head,
      line: line.number,
      column: sel.head - line.from + 1,
      hasSelection: sel.from !== sel.to,
    }
  },
  scrollToPos(pos) {
    if (!view.value) return
    view.value.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'center', yMargin: 60 }),
    })
  },
  poke() {
    view.value?.dispatch({})
  },
  getSelection() {
    if (!view.value) return null
    const sel = view.value.state.selection.main
    if (sel.from === sel.to) return null
    return {
      from: sel.from,
      to: sel.to,
      text: view.value.state.sliceDoc(sel.from, sel.to),
    }
  },
  format(action) {
    if (!view.value) return
    const actions = {
      'bold': () => fmt.toggleBold(view.value),
      'italic': () => fmt.toggleItalic(view.value),
      'code': () => fmt.toggleCode(view.value),
      'heading-1': () => fmt.toggleHeading(view.value, 1),
      'heading-2': () => fmt.toggleHeading(view.value, 2),
      'heading-3': () => fmt.toggleHeading(view.value, 3),
      'bullet-list': () => fmt.toggleBulletList(view.value),
      'numbered-list': () => fmt.toggleNumberedList(view.value),
      'checkbox': () => fmt.toggleCheckbox(view.value),
      'link': () => fmt.insertLink(view.value),
      'image': () => fmt.insertImage(view.value),
      'cite': () => fmt.insertCitation(view.value),
      'citation': () => fmt.insertCitation(view.value),
      'strikethrough': () => fmt.toggleStrikethrough(view.value),
      'blockquote': () => fmt.toggleBlockquote(view.value),
      'horizontal-rule': () => fmt.insertHorizontalRule(view.value),
    }
    const fn = actions[action]
    if (fn) fn()
    view.value.focus()
  },
  edit(action) {
    if (!view.value) return
    const commands = {
      undo: () => undo(view.value),
      redo: () => redo(view.value),
      cut: () => {
        view.value.focus()
        document.execCommand('cut')
      },
      copy: () => {
        view.value.focus()
        document.execCommand('copy')
      },
      paste: () => {
        view.value.focus()
        document.execCommand('paste')
      },
      'select-all': () => selectAll(view.value),
      find: () => openSearchPanel(view.value),
    }
    commands[action]?.()
  },
  coordsAtPos(pos) {
    return view.value?.coordsAtPos(pos) ?? null
  },
  getScrollInfo() {
    if (!view.value) return null
    return {
      scrollTop: view.value.scrollDOM.scrollTop,
      scrollHeight: view.value.scrollDOM.scrollHeight,
      clientHeight: view.value.scrollDOM.clientHeight,
    }
  },
  getView() {
    return view.value
  },
})

const wrapperStyle = computed(() => {
  const baseFontSize = settings.editorFontSize
  const zoom = props.zoomLevel / 100
  const s = {
    '--editor-size': (baseFontSize * zoom) + 'px',
    '--editor-line-height': ((23 * baseFontSize / 12) * zoom) + 'px',
    '--font-mono': fontFamilyForKey(settings.editorFontFamily),
  }
  if (props.maxWidth) {
    s['--editor-max-width'] = props.maxWidth
  }
  return s
})

function onCMChange() {
  if (applyingExternalContent) return
  emit('change')
}

function onCMCursor(info) {
  emit('cursor', info)
  if (!info.hasSelection) {
    emit('selection-change', '')
  }
}

function onCMSelectionCommand(sel) {
  emit('selection-command', sel)

  // Compute selection stats
  const text = sel.text
  const chars = text.length
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  emit('selection-change', `${chars} chars · ${words} words`)
}

onMounted(() => {
  view.value = createEditor({
    parent: cmHost.value,
    doc: props.content,
    path: props.path,
    extensions: props.extensions,
    onChange: onCMChange,
    onCursor: onCMCursor,
    onSelectionCommand: onCMSelectionCommand,
    onActiveFormats: (formats) => emit('active-formats', formats),
    initialSettings: {
      wordWrap: settings.editorWordWrap,
      spellCheck: settings.editorSpellCheck,
      isDark: settings.isDarkTheme,
    },
  })
})

onUnmounted(() => {
  if (view.value) {
    view.value.destroy()
    view.value = null
  }
})

// ── Reconfigure CM6 when settings change ──

watch(() => settings.editorWordWrap, (on) => {
  if (!view.value) return
  view.value.dispatch({
    effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
  })
})

watch(() => settings.editorSpellCheck, (on) => {
  if (!view.value) return
  view.value.dispatch({
    effects: spellcheckCompartment.reconfigure(editorInputAttributesExtension(on)),
  })
})

watch(() => props.path, (path) => {
  if (!view.value) return
  view.value.dispatch({
    effects: languageCompartment.reconfigure(languageExtensionForPath(path)),
  })
})

watch(() => settings.isDarkTheme, (dark) => {
  if (!view.value) return
  view.value.dispatch({
    effects: darkModeCompartment.reconfigure(dark ? EditorView.darkTheme.of(true) : []),
  })
})

// Watch for external content changes (tab switches)
watch(() => props.content, (newContent) => {
  if (!view.value) return
  const currentContent = view.value.state.doc.toString()
  if (newContent === currentContent) return
  applyingExternalContent = true
  try {
    let prefixLen = 0
    const minLen = Math.min(currentContent.length, newContent.length)
    while (prefixLen < minLen && currentContent[prefixLen] === newContent[prefixLen]) prefixLen++

    let suffixLen = 0
    const maxSuffix = minLen - prefixLen
    while (suffixLen < maxSuffix &&
           currentContent[currentContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]) {
      suffixLen++
    }

    const from = prefixLen
    const to = currentContent.length - suffixLen
    const insert = newContent.slice(prefixLen, newContent.length - suffixLen)

    if (from !== to || insert.length > 0) {
      view.value.dispatch({ changes: { from, to, insert } })
    }
  } finally {
    applyingExternalContent = false
  }
})
</script>

<style scoped>
/* Thin scrollbar on the CM scroller */
.editor-wrap :deep(.cm-scroller)::-webkit-scrollbar {
  width: 4px;
}
.editor-wrap :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: var(--color-rule);
  border-radius: 2px;
}

/* maxWidth override via CSS variable */
.editor-wrap :deep(.cm-content) {
  max-width: var(--editor-max-width, none);
}
</style>
