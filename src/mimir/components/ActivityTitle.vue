<template>
  <div class="no-drag min-w-0 text-[12px] font-semibold leading-none">
    <input
      v-if="renaming"
      ref="renameInput"
      v-model="draft"
      data-tab-rename
      aria-label="Session name"
      maxlength="160"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      class="h-7 w-full min-w-0 border border-accent bg-surface px-1 text-ink focus:outline-none"
      @keydown="renameKey"
      @blur="cancelRename"
    />
    <button
      v-else
      ref="titleButton"
      type="button"
      data-activity-title-rename
      :aria-label="`Rename ${activity.title}`"
      title="Rename session"
      class="h-7 max-w-full truncate px-1 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @click="beginRename(activity)"
      @keydown="titleKey"
    >{{ activity.title }}</button>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { useActivityRename } from '../composables/useActivityNavigation.js'

const props = defineProps({
  activity: { type: Object, required: true },
  hidden: Boolean,
})
const emit = defineEmits(['rename'])
const titleButton = ref(null)
const { renaming, draft, renameInput, beginRename, cancelRename, renameKey } = useActivityRename(emit, {
  canRename: () => !props.hidden,
  focus: () => nextTick(() => titleButton.value?.focus()),
})

function titleKey(event) {
  if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'F2') {
    event.preventDefault()
    beginRename(props.activity)
  }
}

watch(() => [props.activity.id, props.hidden], cancelRename)
</script>
