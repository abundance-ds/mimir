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
      :ai-enabled="inlineAIEnabled"
      @close="ctxMenu.show = false"
      @comment="emit('comment')"
      @ask-agent="emit('ask-agent')"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, shallowRef, nextTick } from 'vue'
import { Compartment, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo, redo, selectAll, isolateHistory } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { createEditor, createEditorState, darkModeCompartment, editorInputAttributesExtension, languageCompartment, languageExtensionForPath, lineIndicatorCompartment, lineIndicatorExtensions, wrapCompartment, spellcheckCompartment } from '../../codemirror/core.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { editorTypographyVars } from '../../../shared/fonts.js'
import * as fmt from '../../codemirror/formatting.js'
import EditorContextMenu from './EditorContextMenu.vue'

const props = defineProps({
  content: { type: String, default: '' },
  contentOrigin: { type: String, default: 'reload' },
  path: { type: String, default: '' },
  fileId: { type: [String, Number], default: '' },
  openFileIds: { type: Array, default: () => [] },
  zoomLevel: { type: Number, default: 100 },
  maxWidth: { type: String, default: '' },
  showBorder: { type: Boolean, default: false },
  extensions: { type: Array, default: () => [] },
  inlineAIEnabled: { type: Boolean, default: true },
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
let typographyMeasureGeneration = 0
let activeFileId = props.fileId
let activeLineEnding = lineEndingFor(props.content)
const featureCompartment = new Compartment()
const fileStates = new Map()

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
  focus() {
    view.value?.focus()
  },
  getContent() {
    return view.value ? documentContent(view.value.state) : ''
  },
  previewEdit(from, to, text) {
    if (!view.value) return null
    const state = view.value.state
    const doc = state.changes({ from, to, insert: text }).apply(state.doc)
    return doc.sliceString(0, doc.length, activeLineEnding)
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
  scrollToPos(pos, { select = false } = {}) {
    if (!view.value) return
    const position = Math.max(0, Math.min(view.value.state.doc.length, pos))
    view.value.dispatch({
      ...(select ? { selection: { anchor: position } } : {}),
      effects: EditorView.scrollIntoView(position, { y: 'center', yMargin: 60 }),
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
  const s = editorTypographyVars({
    fontSize: settings.editorFontSize,
    zoom: props.zoomLevel / 100,
    fontKey: settings.editorFontFamily,
    dark: settings.isDarkTheme,
  })
  if (props.maxWidth) {
    s['--editor-max-width'] = props.maxWidth
  }
  return s
})

async function remeasureTypography() {
  const generation = ++typographyMeasureGeneration
  const currentView = view.value
  if (!currentView) return

  const style = wrapperStyle.value
  if (style['--font-mono'].startsWith('"Commit Mono"') && document.fonts?.load) {
    const descriptor = `${style['--editor-font-weight']} ${style['--editor-size']} "Commit Mono"`
    try {
      await document.fonts.load(descriptor)
    } catch {
      // Keep the fallback stack usable if the browser font API rejects.
    }
  }

  await nextTick()
  if (generation !== typographyMeasureGeneration || view.value !== currentView) return
  currentView.requestMeasure()
}

function lineEndingFor(content, fallback = '\n') {
  return content.match(/\r\n?|\n/)?.[0] || fallback
}

function documentContent(state) {
  return state.doc.sliceString(0, state.doc.length, activeLineEnding)
}

function onCMChange(update) {
  if (applyingExternalContent) return
  // Bind the transaction to the loaded document, even when props already name
  // the next document. The parent commits this text before dispatch returns.
  emit('change', { fileId: activeFileId, content: documentContent(update.state) })
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

function stateOptionsFor(doc, path) {
  return {
    doc,
    path,
    extensions: [featureCompartment.of(props.extensions)],
    onChange: onCMChange,
    onCursor: onCMCursor,
    onSelectionCommand: onCMSelectionCommand,
    isSelectionRewriteEnabled: () => props.inlineAIEnabled,
    onActiveFormats: (formats) => emit('active-formats', formats),
    initialSettings: {
      wordWrap: settings.editorWordWrap,
      spellCheck: settings.editorSpellCheck,
      lineNumbers: settings.editorLineNumbers,
      isDark: settings.isDarkTheme,
    },
  }
}

function currentSettingsEffects() {
  return [
    wrapCompartment.reconfigure(settings.editorWordWrap ? EditorView.lineWrapping : []),
    spellcheckCompartment.reconfigure(editorInputAttributesExtension(settings.editorSpellCheck)),
    lineIndicatorCompartment.reconfigure(lineIndicatorExtensions(settings.editorLineNumbers)),
    darkModeCompartment.reconfigure(settings.isDarkTheme ? EditorView.darkTheme.of(true) : []),
    featureCompartment.reconfigure(props.extensions),
  ]
}

function syncDerivedViewState() {
  const state = view.value.state
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.head)
  onCMCursor({
    line: line.number,
    column: selection.head - line.from + 1,
    offset: selection.head,
    hasSelection: selection.from !== selection.to,
  })
  emit('active-formats', fmt.detectActiveFormats(state))
}

function applyBackgroundContent(newContent) {
  activeLineEnding = lineEndingFor(newContent, activeLineEnding)
  newContent = newContent.replace(/\r\n?/g, '\n')
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
      view.value.dispatch({
        changes: { from, to, insert },
        // Project the accepted store snapshot exactly; typing filters must not
        // silently change a reload or an accepted proposal (e.g. comment tags).
        filter: false,
        annotations: [
          Transaction.addToHistory.of(props.contentOrigin === 'edit'),
          isolateHistory.of('full'),
        ],
      })
    }
  } finally {
    applyingExternalContent = false
  }
}

function languageEffect(path) {
  return languageCompartment.reconfigure(languageExtensionForPath(path))
}

function switchFile(fileId, content, path, previousPath) {
  fileStates.set(activeFileId, {
    state: view.value.state,
    scrollTop: view.value.scrollDOM.scrollTop,
    lineEnding: activeLineEnding,
    path: previousPath,
  })
  activeFileId = fileId

  const cached = fileStates.get(fileId)
  if (cached) {
    activeLineEnding = cached.lineEnding
    view.value.setState(cached.state)
    view.value.dispatch({
      effects: cached.path === path
        ? currentSettingsEffects()
        : [...currentSettingsEffects(), languageEffect(path)],
    })
    view.value.scrollDOM.scrollTop = cached.scrollTop
    syncDerivedViewState()
    applyBackgroundContent(content)
    return
  }

  const state = createEditorState(stateOptionsFor(content, path))
  activeLineEnding = lineEndingFor(content)
  view.value.setState(state)
  view.value.scrollDOM.scrollTop = 0
  syncDerivedViewState()
}

onMounted(() => {
  view.value = createEditor({
    parent: cmHost.value,
    ...stateOptionsFor(props.content, props.path),
  })
  fileStates.set(activeFileId, {
    state: view.value.state,
    scrollTop: 0,
    lineEnding: activeLineEnding,
    path: props.path,
  })
  void remeasureTypography()
})

onUnmounted(() => {
  typographyMeasureGeneration++
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

watch(() => settings.editorLineNumbers, (on) => {
  if (!view.value) return
  view.value.dispatch({
    effects: lineIndicatorCompartment.reconfigure(lineIndicatorExtensions(on)),
  })
})

watch(() => settings.isDarkTheme, (dark) => {
  if (!view.value) return
  view.value.dispatch({
    effects: darkModeCompartment.reconfigure(dark ? EditorView.darkTheme.of(true) : []),
  })
})

watch([
  () => settings.editorFontFamily,
  () => settings.editorFontSize,
  () => settings.isDarkTheme,
  () => props.zoomLevel,
], () => {
  void remeasureTypography()
}, { flush: 'post' })

watch(() => props.extensions, (extensions) => {
  if (!view.value) return
  view.value.dispatch({
    effects: featureCompartment.reconfigure(extensions),
  })
})

watch(
  [() => props.fileId, () => props.content, () => props.path],
  ([fileId, content, path], [, , previousPath]) => {
    if (!view.value) return
    if (fileId !== activeFileId) {
      switchFile(fileId, content, path, previousPath)
      return
    }
    if (path !== previousPath) view.value.dispatch({ effects: languageEffect(path) })
    applyBackgroundContent(content)
  },
  // Visibility must be patched before switchFile reads the retained Source scroll.
  { flush: 'post' },
)

watch(() => props.openFileIds, (ids) => {
  const keep = new Set(ids)
  for (const id of fileStates.keys()) {
    if (id !== activeFileId && !keep.has(id)) fileStates.delete(id)
  }
}, { flush: 'post' })
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
