<template>
  <Teleport to="body">
    <template v-if="visible">
      <div class="ctx-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')"></div>
      <div ref="menuElement" class="ctx-menu" role="menu" aria-label="Text actions" :style="menuStyle" @click.stop @keydown="onMenuKeydown">
        <template v-if="suggestions.length > 0">
          <button role="menuitem"
            v-for="s in suggestions.slice(0, 5)"
            :key="s"
            class="ctx-item spell-item"
            @click="applySuggestion(s)"
          >{{ s }}</button>
          <div class="ctx-divider" />
        </template>

        <template v-if="hasSelection">
          <button role="menuitem" class="ctx-item" @click="cut">Cut <span class="ctx-shortcut">⌘X</span></button>
          <button role="menuitem" class="ctx-item" @click="copy">Copy <span class="ctx-shortcut">⌘C</span></button>
          <button role="menuitem" class="ctx-item" @click="paste">Paste <span class="ctx-shortcut">⌘V</span></button>
          <div class="ctx-divider" />
          <button role="menuitem" v-if="allowComments" class="ctx-item" @click="addComment">Add Comment <span class="ctx-shortcut">⇧⌘M</span></button>
          <button role="menuitem" v-if="aiEnabled" class="ctx-item ctx-ai" @click="askAI">Ask AI <span class="ctx-shortcut">⌘K</span></button>
        </template>
        <template v-else>
          <button role="menuitem" class="ctx-item" @click="paste">Paste <span class="ctx-shortcut">⌘V</span></button>
          <button role="menuitem" class="ctx-item" @click="selectAll">Select All <span class="ctx-shortcut">⌘A</span></button>
        </template>
      </div>
    </template>
  </Teleport>
</template>

<script setup>
import { nextTick, ref, toRaw, watch } from 'vue'
import { spellingSuggestions } from '../../../services/spelling.js'
import { spellingWordAt } from '../../codemirror/spelling.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  hasSelection: { type: Boolean, default: false },
  view: { type: Object, default: null },
  spellcheckEnabled: { type: Boolean, default: false },
  aiEnabled: { type: Boolean, default: true },
  allowComments: { type: Boolean, default: true },
  position: { type: Number, default: null },
})

const emit = defineEmits(['close', 'comment', 'ask-agent'])

const suggestions = ref([])
let target = null
let request = 0
const menuElement = ref(null)
const menuStyle = ref({})

watch(() => [props.visible, props.x, props.y, props.position, props.view, props.spellcheckEnabled], async () => {
  const generation = ++request
  suggestions.value = []
  target = null
  if (!props.visible) return
  const menuW = 200, menuH = props.hasSelection ? 240 : 100
  const x = Math.max(0, Math.min(props.x, window.innerWidth - menuW - 8))
  const y = Math.max(0, Math.min(props.y, window.innerHeight - menuH - 8))
  menuStyle.value = { position: 'fixed', left: x + 'px', top: y + 'px' }
  await nextTick()
  if (generation !== request) return
  menuElement.value?.querySelector('button')?.focus({ preventScroll: true })

  if (!props.spellcheckEnabled || !props.view) return
  const view = toRaw(props.view)
  const doc = view.state.doc
  const pos = props.position ?? view.posAtCoords({ x: props.x, y: props.y })
  if (pos === null) return
  const word = spellingWordAt(view.state, pos)
  if (!word) return
  try {
    const result = await spellingSuggestions(word.text)
    if (props.visible && generation === request && toRaw(props.view) === view && view.state.doc === doc) {
      target = { ...word, doc, view }
      suggestions.value = result
      await nextTick()
      // Suggestions can increase the menu height after the first paint.
      const height = menuElement.value?.getBoundingClientRect().height || menuH
      menuStyle.value.top = Math.max(0, Math.min(props.y, window.innerHeight - height - 8)) + 'px'
    }
  } catch { /* A failed system lookup must not disable the other text actions. */ }
}, { immediate: true })

function applySuggestion(text) {
  if (target && toRaw(props.view) === target.view && !target.view.state.readOnly && target.view.state.doc === target.doc) {
    target.view.dispatch({ changes: { from: target.from, to: target.to, insert: text }, userEvent: 'input.spelling' })
    target.view.focus()
  }
  emit('close')
}

function onMenuKeydown(event) {
  const buttons = [...(menuElement.value?.querySelectorAll('button') || [])]
  const current = buttons.indexOf(document.activeElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    toRaw(props.view)?.focus()
    emit('close')
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[index]?.focus()
  } else if (event.key === 'Tab') emit('close')
}

function cut() {
  toRaw(props.view)?.focus()
  document.execCommand('cut')
  emit('close')
}

function copy() {
  toRaw(props.view)?.focus()
  document.execCommand('copy')
  emit('close')
}

function paste() {
  toRaw(props.view)?.focus()
  document.execCommand('paste')
  emit('close')
}

function addComment() {
  emit('comment')
  emit('close')
}

function askAI() {
  emit('ask-agent')
  emit('close')
}

function selectAll() {
  if (props.view) {
    toRaw(props.view).dispatch({
      selection: { anchor: 0, head: props.view.state.doc.length },
    })
  }
  emit('close')
}
</script>

<style scoped>
.ctx-overlay {
  position: fixed; inset: 0; z-index: 200;
}
.ctx-menu {
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 6px;
  padding: 4px; min-width: 160px; z-index: 201;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.ctx-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border-radius: 4px;
  font-family: var(--font-sans); font-size: 12px; color: var(--color-ink-2);
  text-align: left;
}
.ctx-item:hover { background: var(--color-rule-light); color: var(--color-ink); }
.ctx-ai { color: var(--color-accent); }
.ctx-ai:hover { color: var(--color-accent); background: var(--color-accent-soft); }
.spell-item { font-weight: 600; color: var(--color-accent); }
.spell-item:hover { color: var(--color-ink); }
.ctx-divider {
  height: 1px; background: var(--color-rule-light); margin: 3px 4px;
}
.ctx-shortcut {
  margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
}
</style>
