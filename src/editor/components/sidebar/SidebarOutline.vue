<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div v-if="outline.length" class="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin py-1.5">
      <div
        v-for="(item, i) in outline"
        :key="item.from"
        class="group flex items-center whitespace-nowrap relative overflow-hidden py-[5px] px-3 rounded-[3px] mx-1.5"
        :class="[
          activeIndex === i ? 'bg-surface' : currentHeadingIndex === i ? 'bg-surface/50' : 'hover:bg-surface/40',
        ]"
        :style="{ paddingLeft: (10 + (item.level - 1) * 12) + 'px' }"
        @click="onRowClick(i, item)"
      >
        <span
          class="flex-1 min-w-0 overflow-hidden text-ellipsis font-sans"
          :class="[
            activeIndex === i ? 'text-ink font-medium' : headingClasses(item),
          ]"
        >{{ item.text }}</span>
      </div>
    </div>
    <div v-else class="flex-1 flex flex-col items-center justify-center px-4">
      <span class="font-sans text-[11.5px] text-ink-3">No headings found</span>
      <span class="font-sans text-[10px] text-ink-3 mt-1">Add # headings to your document</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  outline: { type: Array, default: () => [] },
  cursorLine: { type: Number, default: 0 },
})
const emit = defineEmits(['scroll-to-pos'])

const activeIndex = ref(null)
const outline = computed(() => props.outline)

const currentHeadingIndex = computed(() => {
  if (!props.outline.length) return -1
  let best = -1
  for (let i = 0; i < props.outline.length; i++) {
    if (props.outline[i].line <= props.cursorLine) best = i
  }
  return best
})

function headingClasses(item) {
  switch (item.level) {
    case 1: return 'text-[11.5px] font-semibold text-ink'
    case 2: return 'text-[11px] font-medium text-ink-2'
    case 3: return 'text-[10.5px] text-ink-3'
    default: return 'text-[10px] text-ink-3'
  }
}

watch(outline, () => {
  if (activeIndex.value != null && activeIndex.value >= props.outline.length) {
    activeIndex.value = null
  }
})

function onRowClick(i, item) {
  activeIndex.value = i
  emit('scroll-to-pos', item.from)
}
</script>
