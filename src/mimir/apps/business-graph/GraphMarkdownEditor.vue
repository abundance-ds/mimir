<template>
  <div
    ref="host"
    data-graph-markdown-editor
    class="graph-markdown-editor"
    :class="{ 'graph-markdown-editor-unframed': !framed }"
    :style="{ '--graph-editor-min-height': `${minHeight}px` }"
    :aria-busy="disabled"
  />
</template>

<script setup>
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as editorPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
import { markdownListKeymap } from '../../../editor/codemirror/markdownLists.js'
import { markdownLinkOpen } from './markdownLinkOpen.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Markdown working note' },
  placeholder: { type: String, default: 'Add context, reasoning, evidence, or next steps…' },
  minHeight: { type: Number, default: 320 },
  disabled: { type: Boolean, default: false },
  autofocus: { type: Boolean, default: false },
  framed: { type: Boolean, default: true },
  controlId: { type: String, default: 'working-note-input' },
})

const emit = defineEmits(['update:modelValue', 'change', 'save', 'open-file'])
const host = ref(null)
const editableCompartment = new Compartment()
let view = null
let applyingExternal = false

const graphHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: 'var(--color-ink)',
    fontWeight: '650',
  },
  { tag: tags.strong, color: 'var(--color-ink)', fontWeight: '680' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)', textDecoration: 'underline' },
  {
    tag: tags.monospace,
    color: 'var(--code, var(--color-ink-2))',
    fontFamily: 'var(--font-mono)',
  },
  { tag: tags.quote, color: 'var(--color-ink-3)', fontStyle: 'italic' },
  { tag: tags.contentSeparator, color: 'var(--color-ink-4)' },
])

const graphEditorTheme = framed => EditorView.theme({
  '&': {
    minHeight: 'var(--graph-editor-min-height)',
    width: '100%',
    borderRadius: framed ? '3px' : '0',
    color: 'var(--color-ink)',
    backgroundColor: framed ? 'var(--color-chrome-high)' : 'transparent',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: framed
      ? '2px solid color-mix(in srgb, var(--color-accent) 22%, transparent)'
      : 'none',
    outlineOffset: '1px',
  },
  '.cm-scroller': {
    minHeight: 'var(--graph-editor-min-height)',
    overflowX: 'auto',
    overflowY: 'visible',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: 'var(--graph-editor-min-height)',
    padding: framed ? '12px 14px 44px' : '4px 0 28px',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': {
    color: 'var(--color-ink-4)',
    fontFamily: 'var(--font-sans)',
    fontStyle: 'normal',
  },
})

onMounted(() => {
  const state = EditorState.create({
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
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      markdownListKeymap,
      markdownLinkOpen({ onOpen: target => emit('open-file', target) }),
      syntaxHighlighting(graphHighlightStyle),
      graphEditorTheme(props.framed),
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
  })
  view = new EditorView({ state, parent: host.value })
  if (props.autofocus) requestAnimationFrame(() => view?.focus())
})

watch(() => props.modelValue, (value) => {
  if (!view || view.state.doc.toString() === value) return
  applyingExternal = true
  view.dispatch({
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

defineExpose({ focus, getValue, setValue })

onUnmounted(() => {
  view?.destroy()
  view = null
})
</script>

<style scoped>
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
