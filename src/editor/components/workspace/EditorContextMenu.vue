<template>
  <Teleport to="body">
    <template v-if="visible">
      <div class="ctx-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')"></div>
      <div class="ctx-menu" :style="menuStyle" @click.stop>
        <template v-if="suggestions.length > 0">
          <button
            v-for="s in suggestions.slice(0, 5)"
            :key="s"
            class="ctx-item spell-item"
            @click="applySuggestion(s)"
          >{{ s }}</button>
          <div class="ctx-divider" />
        </template>

        <template v-if="hasSelection">
          <button class="ctx-item" @click="cut">Cut <span class="ctx-shortcut">⌘X</span></button>
          <button class="ctx-item" @click="copy">Copy <span class="ctx-shortcut">⌘C</span></button>
          <button class="ctx-item" @click="paste">Paste <span class="ctx-shortcut">⌘V</span></button>
          <div class="ctx-divider" />
          <button class="ctx-item" @click="addComment">Add Comment <span class="ctx-shortcut">⇧⌘M</span></button>
          <button class="ctx-item ctx-ai" @click="askAI">Ask AI <span class="ctx-shortcut">⌘K</span></button>
        </template>
        <template v-else>
          <button class="ctx-item" @click="paste">Paste <span class="ctx-shortcut">⌘V</span></button>
          <button class="ctx-item" @click="selectAll">Select All <span class="ctx-shortcut">⌘A</span></button>
        </template>
      </div>
    </template>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  hasSelection: { type: Boolean, default: false },
  view: { type: Object, default: null },
  spellcheckEnabled: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'comment', 'ask-agent'])

const suggestions = ref([])
let wordFrom = 0
let wordTo = 0

const menuStyle = ref({})

watch(() => props.visible, async (show) => {
  if (!show) {
    suggestions.value = []
    return
  }

  const menuW = 200, menuH = props.hasSelection ? 240 : 100
  const x = Math.min(props.x, window.innerWidth - menuW - 8)
  const y = Math.min(props.y, window.innerHeight - menuH - 8)
  menuStyle.value = { position: 'fixed', left: x + 'px', top: y + 'px' }

  if (props.spellcheckEnabled && props.view && isTauri) {
    const pos = props.view.posAtCoords({ x: props.x, y: props.y })
    if (pos !== null) {
      const word = getWordAt(props.view.state, pos)
      if (word) {
        wordFrom = word.from
        wordTo = word.to
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const result = await invoke('spell_suggest', { word: word.text })
          if (props.visible) {
            suggestions.value = result
          }
        } catch { /* non-macOS or invoke error */ }
      }
    }
  }
})

function getWordAt(state, pos) {
  const line = state.doc.lineAt(pos)
  const text = line.text
  const col = pos - line.from

  let start = col
  while (start > 0 && /[\wÀ-ɏ'-]/.test(text[start - 1])) start--
  let end = col
  while (end < text.length && /[\wÀ-ɏ'-]/.test(text[end])) end++

  if (start === end) return null
  return {
    text: text.slice(start, end),
    from: line.from + start,
    to: line.from + end,
  }
}

function applySuggestion(s) {
  if (!props.view) return
  props.view.dispatch({
    changes: { from: wordFrom, to: wordTo, insert: s },
  })
  emit('close')
}

function cut() {
  document.execCommand('cut')
  emit('close')
}

function copy() {
  document.execCommand('copy')
  emit('close')
}

function paste() {
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
    props.view.dispatch({
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
