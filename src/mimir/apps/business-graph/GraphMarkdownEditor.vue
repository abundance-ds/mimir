<template>
  <div class="graph-note-input" :style="canvasTypography">
    <div v-if="!canvasStyle" class="graph-note-tools">
      <button
        type="button"
        data-graph-insert-link
        data-graph-control="note-insert-link"
        aria-label="Insert graph link"
        title="Insert graph link (@)"
        :disabled="disabled"
        @mousedown.prevent
        @click="insertLink"
      ><IconLink :size="13" /><span>Link</span></button>
      <span v-if="linkError" role="status">{{ linkError }}</span>
    </div>
    <p v-if="canvasStyle && linkError" role="status" class="text-ink-3 text-xs">{{ linkError }}</p>
    <div
      ref="host"
      data-graph-markdown-editor
      class="graph-markdown-editor"
      :class="{ 'graph-markdown-editor-unframed': !framed }"
      :style="{ '--graph-editor-min-height': `${minHeight}px` }"
      :aria-busy="disabled"
    />
  </div>
</template>

<script setup>
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as editorPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyField, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { IconLink } from '@tabler/icons-vue'
import { graphLinks } from '../../../editor/codemirror/graphLinks.js'
import { referenceSelection } from '../../../editor/codemirror/graphLinkSyntax.js'
import { lookupGraph, graphLinkTargets } from '../../../services/businessGraph.js'
import { markdownListKeymap } from '../../../editor/codemirror/markdownLists.js'
import { markdownLinkOpen } from './markdownLinkOpen.js'
import { editorTheme, editorHighlightStyle, languageExtensionForPath } from '../../../editor/codemirror/core.js'
import { syntaxHighlighting } from '@codemirror/language'
import { livePreviewExtension } from '../../../editor/codemirror/livePreview.js'
import { taskCheckboxExtension } from '../../../editor/codemirror/taskCheckboxes.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { editorTypographyVars } from '../../../shared/fonts.js'
import { canvasLayout } from './homeCanvasStyles.js'
import { graphMarkdownStyles } from './graphMarkdownStyles.js'

const props = defineProps({
  canvasStyle: { type: Boolean, default: false },
  modelValue: { type: String, default: '' },
  viewState: { type: Object, default: null },
  ariaLabel: { type: String, default: 'Markdown working note' },
  placeholder: { type: String, default: 'Add context, reasoning, evidence, or next steps…' },
  minHeight: { type: Number, default: 320 },
  disabled: { type: Boolean, default: false },
  autofocus: { type: Boolean, default: false },
  framed: { type: Boolean, default: true },
  controlId: { type: String, default: 'working-note-input' },
  openLinks: { type: Boolean, default: false },
  scopeIds: { type: Array, default: () => [] },
  graphRevision: { type: [Number, String], default: 0 },
})

const emit = defineEmits(['update:modelValue', 'change', 'save', 'open-file', 'open-url', 'open-graph'])
const host = ref(null)
const linkError = ref('')
const links = graphLinks({
  lookup: lookupGraph,
  resolve: graphLinkTargets,
  scopeIds: () => props.scopeIds,
  enabled: () => props.openLinks,
  open: id => emit('open-graph', id),
  onError: message => { linkError.value = message },
})
const settings = props.canvasStyle ? useSettingsStore() : null
const canvasTypography = computed(() => settings ? editorTypographyVars({ fontSize: settings.editorFontSize, fontKey: settings.editorFontFamily, dark: settings.isDarkTheme }) : null)
const editableCompartment = new Compartment()
let view = null
let applyingExternal = false

onMounted(() => {
  const config = {
    doc: props.modelValue,
    extensions: [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': props.ariaLabel,
        spellcheck: 'true',
        autocorrect: 'off',
        autocapitalize: 'off',
        'data-graph-control': props.controlId,
      }),
      editableCompartment.of(editableExtensions(props.disabled)),
      history(),
      drawSelection(),
      props.canvasStyle ? languageExtensionForPath('home.md') : markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      markdownListKeymap,
      links.extension,
      markdownLinkOpen({
        enabled: () => props.openLinks,
        selector: props.canvasStyle ? '.cm-lp-link' : '.cm-graph-link',
        preserveRenderedLink: props.canvasStyle,
        onOpenFile: target => emit('open-file', target),
        onOpenUrl: target => emit('open-url', target),
        onOpenGraph: target => links.openTarget(target),
      }),
      props.canvasStyle ? [canvasLayout, editorTheme, syntaxHighlighting(editorHighlightStyle),
        livePreviewExtension(() => true, () => '', state => links.references(state)), taskCheckboxExtension(() => true)]
        : graphMarkdownStyles(props.framed, props.openLinks),
      editorPlaceholder(props.placeholder),
      keymap.of([
        {
          key: 'Mod-s',
          run() {
            emit('save')
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternal) return
        const value = update.state.doc.toString()
        emit('update:modelValue', value)
        emit('change', value)
      }),
    ],
  }
  const snapshot = props.viewState?.note
  const normalized = String(props.modelValue).replace(/\r\n?/g, '\n')
  const state = snapshot?.doc === normalized
    ? EditorState.fromJSON(snapshot, config, { history: historyField })
    : EditorState.create(config)
  view = new EditorView({ state, parent: host.value })
  if (props.autofocus) requestAnimationFrame(() => view?.focus())
})

watch(() => props.modelValue, (value) => {
  if (!view || view.state.doc.toString() === value) return
  applyingExternal = true
  view.dispatch({
    annotations: props.canvasStyle ? Transaction.addToHistory.of(false) : [],
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: value,
    },
  })
  applyingExternal = false
})

watch(() => props.disabled, (disabled) => {
  view?.dispatch({
    effects: editableCompartment.reconfigure(editableExtensions(disabled)),
  })
})

watch(() => [props.graphRevision, props.scopeIds.join('\0')], () => links.refresh())

function insertLink() {
  links.insert(view)
}

function revealReference(request, sourceRevision) {
  if (!view) return
  const selection = referenceSelection(view.state, request, sourceRevision, { sourceBody: props.modelValue })
  view.dispatch({ selection, scrollIntoView: true })
  view.focus()
}

function editableExtensions(disabled) {
  return [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
  ]
}

function focus() {
  view?.focus()
}

function getValue() {
  return view?.state.doc.toString() || ''
}

function setValue(value) {
  if (!view) return
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: String(value ?? ''),
    },
  })
}

defineExpose({ focus, getValue, setValue, insertLink, revealReference })

onUnmounted(() => {
  if (view && props.viewState) props.viewState.note = view.state.toJSON({ history: historyField })
  view?.destroy()
  view = null
})
</script>

<style scoped>
.graph-note-input { min-width: 0; }
.graph-note-tools { display: flex; align-items: center; gap: 10px; min-height: 26px; color: var(--color-ink-3); font-size: 11px; }
.graph-note-tools button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; color: var(--color-ink-3); }
.graph-note-tools button:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-note-tools button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.graph-note-tools button:disabled { opacity: .5; }

.graph-markdown-editor {
  min-height: var(--graph-editor-min-height);
  border: 1px solid var(--color-rule-light);
  border-radius: 3px;
  background: var(--color-chrome-high);
}

.graph-markdown-editor-unframed {
  border: 0;
  border-radius: 0;
  background: transparent;
}
</style>
