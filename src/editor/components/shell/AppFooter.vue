<template>
  <div class="app-footer h-[26px] shrink-0 grid grid-cols-[1fr_auto_1fr] items-center px-[28px] bg-chrome font-mono text-[10px] text-ink-3 tracking-[0.4px] whitespace-nowrap overflow-visible">
    <!-- Left: stats -->
    <div class="footer-stats flex items-center justify-self-start relative min-w-0">
      <div class="relative flex items-center hover:bg-chrome-mid rounded" @click.stop="statsOpen = !statsOpen">
        <span v-show="!selectionText" class="footer-stat-text hover:text-ink-2">{{ formatNumber(stats.words) }} words · {{ formatNumber(stats.characters) }} chars</span>
        <span v-show="selectionText" class="footer-stat-text text-accent">{{ selectionText }}</span>
      </div>
      <button
        v-if="saveStatus.label && saveStatus.action"
        type="button"
        class="footer-save-status"
        :class="[`save-${saveStatus.tone}`, 'is-actionable']"
        :title="saveStatus.title"
        @click.stop="$emit('save-status-click', saveStatus)"
      >
        <span>{{ saveStatus.label }}</span>
        <span
          v-if="saveStatus.detail"
          class="footer-save-detail"
          :class="`detail-${saveStatus.detailTone || saveStatus.tone}`"
        >{{ saveStatus.detail }}</span>
      </button>
      <span
        v-else-if="saveStatus.label"
        class="footer-save-status"
        :class="`save-${saveStatus.tone}`"
      >
        <span>{{ saveStatus.label }}</span>
        <span
          v-if="saveStatus.detail"
          class="footer-save-detail"
          :class="`detail-${saveStatus.detailTone || saveStatus.tone}`"
        >{{ saveStatus.detail }}</span>
      </span>
      <div
        v-show="statsOpen"
        class="absolute bottom-[calc(100%+8px)] left-0 bg-surface border border-rule rounded-[6px] py-1.5 min-w-[210px] font-sans text-[11px] z-20"
      >
        <div v-for="row in statsRows" :key="row.label" class="flex justify-between px-3 py-[5px] text-ink-2">
          <span>{{ row.label }}</span>
          <span class="font-mono text-[10px] text-ink-3">{{ row.value }}</span>
        </div>
      </div>
    </div>

    <!-- Center: zoom -->
    <div class="footer-zoom zoom-ctrl group flex items-center justify-self-center relative" @click.stop>
      <button class="zoom-step" @click="$emit('zoom-out')">−</button>
      <span class="min-w-9 text-center font-mono text-[9px] leading-none text-ink-3 hover:text-ink-2 hover:bg-chrome-mid rounded" @click="zoomOpen = !zoomOpen">{{ zoomLevel }}%</span>
      <button class="zoom-step" @click="$emit('zoom-in')">+</button>
      <div
        v-show="zoomOpen"
        class="absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-surface border border-rule rounded-[6px] py-1 min-w-[80px] z-20"
      >
        <button
          v-for="level in zoomPresets"
          :key="level"
          class="flex items-center w-full px-3 py-1 font-mono text-[10px] text-ink-2 gap-1.5 hover:bg-chrome-mid"
          :class="level === zoomLevel ? 'text-accent font-semibold' : ''"
          @click="$emit('set-zoom', level); zoomOpen = false"
        >
          <span class="w-1 h-1 rounded-full" :class="level === zoomLevel ? 'bg-accent' : 'bg-transparent'"></span>
          {{ level }}%
        </button>
      </div>
    </div>

    <!-- Right: view mode -->
    <div class="footer-view flex items-center gap-2 justify-self-end">
      <SegmentedControl :options="['source', 'split', 'preview']" :modelValue="viewMode" @update:modelValue="$emit('set-view', $event)" />
      <span class="footer-shortcut text-ink-3">⌘E</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import SegmentedControl from '../../../shared/ui/SegmentedControl.vue'

const props = defineProps({
  zoomLevel: { type: Number, default: 100 },
  viewMode: { type: String, default: 'source' },
  selectionText: { type: String, default: '' },
  stats: { type: Object, default: () => ({ words: 0, characters: 0, lines: 0, readingMinutes: 1 }) },
  saveStatus: { type: Object, default: () => ({ label: '', tone: 'quiet' }) },
})
defineEmits(['zoom-in', 'zoom-out', 'set-zoom', 'set-view', 'save-status-click'])

const statsOpen = ref(false)
const zoomOpen = ref(false)

const zoomPresets = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]

function formatNumber(n) {
  return n.toLocaleString()
}

const statsRows = computed(() => [
  { label: 'Words', value: formatNumber(props.stats.words) },
  { label: 'Characters', value: formatNumber(props.stats.characters) },
  { label: 'Characters (no spaces)', value: formatNumber(props.stats.characters - (props.stats.spaces ?? 0)) },
  { label: 'Lines', value: formatNumber(props.stats.lines) },
  { label: 'Reading time', value: `~${props.stats.readingMinutes} min` },
])

function closePopovers(e) {
  if (!e.target.closest('.footer-stats')) statsOpen.value = false
  if (!e.target.closest('.zoom-ctrl')) zoomOpen.value = false
}

onMounted(() => document.addEventListener('click', closePopovers))
onUnmounted(() => document.removeEventListener('click', closePopovers))
</script>

<style scoped>
.footer-stat-text {
  display: inline-block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.footer-save-status {
  display: inline-flex;
  align-items: center;
  margin-left: 10px;
  padding: 0 0 0 10px;
  border-left: 1px solid var(--color-rule-light);
  color: var(--color-ink-3);
  font: inherit;
  letter-spacing: inherit;
  background: transparent;
  white-space: nowrap;
}

.footer-save-status.save-failed {
  color: var(--color-rem);
}

.footer-save-status.save-saved {
  color: var(--color-ink-3);
}

.footer-save-status.save-confirmed {
  color: var(--color-accent);
}

.footer-save-status.save-saving,
.footer-save-status.save-dirty,
.footer-save-status.save-auto {
  color: var(--color-ink-3);
}

.footer-save-detail {
  margin-left: 8px;
}

.footer-save-detail.detail-confirmed {
  color: var(--color-accent);
}

.footer-save-detail.detail-saving {
  color: var(--color-ink-3);
}

button.footer-save-status {
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
}

.footer-save-status.is-actionable:hover {
  color: var(--color-ink);
}

.zoom-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  opacity: 0;
}

.footer-zoom:hover .zoom-step,
.zoom-step:focus-visible {
  opacity: 1;
}

.zoom-step:hover,
.zoom-step:focus-visible {
  color: var(--color-ink);
  background: var(--color-chrome-mid);
  outline: none;
}

@media (max-width: 640px) {
  .app-footer {
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 8px;
  }

  .footer-stats {
    overflow: hidden;
  }

  .footer-zoom {
    display: none;
  }

  .footer-shortcut {
    display: none;
  }
}

@media (max-width: 430px) {
  .app-footer {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
    padding-left: 8px;
    padding-right: 8px;
  }

  .footer-stats {
    display: none;
  }

  .footer-view {
    justify-self: center;
  }
}
</style>
