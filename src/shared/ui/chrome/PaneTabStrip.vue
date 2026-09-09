<template>
  <div class="pane-tab-strip no-drag">
    <slot name="leading" />
    <div ref="scroll" role="tablist" :aria-label="label" class="pane-tab-scroll" @wheel="onWheel"><slot /></div>
    <slot name="trailing" />
  </div>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
defineProps({ label: { type: String, required: true } })
const emit = defineEmits(['wheel'])
const scroll = ref(null)
function onWheel(event) {
  emit('wheel', event)
  const el = scroll.value
  if (!el || el.scrollWidth <= el.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  event.preventDefault()
  el.scrollLeft += event.deltaY
}
// Keep the complete selected tab, including Close, visible after a resize.
let observer
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => {
    scroll.value?.querySelector('.pane-tab.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
  if (scroll.value) observer.observe(scroll.value)
})
onBeforeUnmount(() => observer?.disconnect())
defineExpose({ scroll })
</script>
<style>
.pane-tab-strip {
  display: flex;
  align-items: center;
  height: 100%;
  min-width: 0;
  flex: 1;
}

.pane-tab-scroll {
  display: flex;
  height: 100%;
  min-width: 0;
  flex: 1;
  align-items: end;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.pane-tab-scroll::-webkit-scrollbar {
  display: none;
}


</style>
