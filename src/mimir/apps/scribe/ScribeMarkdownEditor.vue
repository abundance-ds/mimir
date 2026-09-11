<template>
  <div
    ref="host"
    data-scribe-markdown-editor
    class="scribe-markdown-editor"
    :aria-busy="disabled"
  />
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as editorPlaceholder } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  selectAll as selectAllCommand,
} from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
import { livePreviewExtension } from '../../../editor/codemirror/livePreview.js'
import { taskCheckboxExtension } from '../../../editor/codemirror/taskCheckboxes.js'
import { markdownListKeymap } from '../../../editor/codemirror/markdownLists.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  ariaLabel: { type: String, required: true },
  placeholder: { type: String, default: 'Write anything…' },
  disabled: { type: Boolean, default: false },
  readOnly: { type: Boolean, default: false },
  autofocus: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'change', 'save'])
const host = ref(null)
const editableCompartment = new Compartment()
let view = null
let applyingExternal = false

const highlightStyle = HighlightStyle.define([
  {
    tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    color: 'var(--color-ink)',
    fontWeight: '600',
  },
  { tag: tags.strong, color: 'var(--color-ink)', fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)' },
  { tag: tags.monospace, color: 'var(--color-ink-2)' },
  { tag: tags.quote, color: 'var(--color-ink-3)' },
  { tag: tags.contentSeparator, color: 'var(--color-ink-4)' },
])

const editorTheme = EditorView.theme({
  '&': {
    width: '100%',
    height: '100%',
    color: 'var(--color-ink)',
    backgroundColor: 'transparent',
    fontSize: '14px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    fontWeight: 'var(--editor-font-weight, 450)',
    lineHeight: '1.45',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: '16px 0 48px',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': {
    color: 'var(--color-ink-4)',
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
        spellcheck: 'false',
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      editableCompartment.of(editableExtensions(props.disabled || props.readOnly)),
      EditorState.tabSize.of(2),
      history(),
      drawSelection(),
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      markdownListKeymap,
      syntaxHighlighting(highlightStyle),
      livePreviewExtension(() => true, null),
      taskCheckboxExtension(() => !props.disabled && !props.readOnly),
      editorTheme,
      editorPlaceholder(props.placeholder),
      keymap.of([
        indentWithTab,
        { key: 'Meta-a', run: editor => selectAllCommand(editor) },
        { key: 'Ctrl-a', run: editor => selectAllCommand(editor) },
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
      EditorView.updateListener.of(update => {
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

watch(() => props.modelValue, value => {
  if (!view || view.state.doc.toString() === value) return
  applyingExternal = true
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: String(value ?? '') },
  })
  applyingExternal = false
})

watch(() => props.disabled || props.readOnly, disabled => {
  view?.dispatch({ effects: editableCompartment.reconfigure(editableExtensions(disabled)) })
})

function editableExtensions(disabled) {
  return [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]
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
    changes: { from: 0, to: view.state.doc.length, insert: String(value ?? '') },
  })
}

defineExpose({ focus, getValue, setValue })

onUnmounted(() => {
  view?.destroy()
  view = null
})
</script>

<style scoped>
.scribe-markdown-editor {
  min-height: 0;
  height: 100%;
  width: 100%;
  background: transparent;
}
</style>
