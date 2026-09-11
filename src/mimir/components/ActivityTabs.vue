<template>
  <PaneTabStrip
    ref="tabStrip" label="Main tabs" class="activity-tabs"
    @keydown="onKeydown"
  >
    <template #leading>
      <ActivityTabMenu :tabs="tabs" :active-id="activeId" :blocking-ids="blockingIds" :restoring-ids="restoringIds"
        @select="$emit('select', $event)" @new="$emit('new')"
      />
    </template>
      <PaneTab
        v-for="tab in tabs"
        :key="tab.id"
        :data-main-tab="tab.id"
        class="main-tab"
        :label="tab.title" :selected="tab.id === activeId"
        :class="{
          selected: tab.id === activeId,
          'drop-before': reorder.dropIndicator.value?.beforeId === tab.id,
          'drop-after': reorder.dropIndicator.value?.afterId === tab.id,
        }"
        @pointerdown="reorder.onPointerDown($event, tab.id)"
        @contextmenu.prevent="showContext(tab, $event)"
      >
        <input
          v-if="renaming === tab.id"
          ref="renameInput"
          v-model="draft"
          data-tab-rename
          aria-label="Session name"
          maxlength="160"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          class="tab-name-input border border-accent bg-surface px-1 text-ink"
          @keydown="renameKey"
          @blur="cancelRename"
        />
        <PaneTabButton
          v-else
          :selected="tab.id === activeId"
          :title="tabTitle(tab)"
          class="tab-select"
          @click="select(tab.id)"
          @dblclick="beginRename(tab)"
        >
          <component
            :is="activityIcon(tab)"
            :size="14"
            :stroke-width="1.7"
            :monochrome="true"
            class="shrink-0"
          />
          <span class="min-w-0 flex-1 truncate">{{ tab.title }}</span>
          <span
            v-if="needsAttention(tab)"
            :title="status(tab)"
            :aria-label="status(tab)"
            class="shrink-0 text-[11px]"
          >!</span>
        </PaneTabButton>
        <PaneTabClose :action="closeLabel(tab)" :label="tab.title" @close="$emit('close', tab.id)" />
      </PaneTab>
    <template #trailing>
    <button
      type="button"
      data-new-main-tab
      title="New tab (⌘T)"
      aria-label="New tab"
      class="pane-icon-button"
      @click="$emit('new')"
    >
      <IconPlus :size="15" :stroke-width="1.8" />
    </button>
    <span class="hidden"
      ><WorkbenchMenu
        ref="context"
        label="Tab actions"
        compact
        :items="contextItems"
        @select="contextAction"
    /></span>
    </template>
  </PaneTabStrip>
</template>
<script setup>
import { computed, ref } from 'vue'
import { IconPlus } from '@tabler/icons-vue'
import { activityIcon } from '../activityIcons.js'
import { useActivityNavigation } from '../composables/useActivityNavigation.js'
import WorkbenchMenu from './WorkbenchMenu.vue'
import ActivityTabMenu from './ActivityTabMenu.vue'
import PaneTab from '../../shared/ui/chrome/PaneTab.vue'
import PaneTabButton from '../../shared/ui/chrome/PaneTabButton.vue'
import PaneTabClose from '../../shared/ui/chrome/PaneTabClose.vue'
import PaneTabStrip from '../../shared/ui/chrome/PaneTabStrip.vue'
const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  blockingIds: { type: Set, default: () => new Set() },
  restoringIds: { type: Set, default: () => new Set() },
})
const emit = defineEmits(['select', 'close', 'rename', 'new', 'reorder'])
const tabStrip = ref(null)
const strip = computed(() => tabStrip.value?.scroll)
const {
  context, renaming, draft, renameInput, closeLabel, status, needsAttention,
  tabTitle, contextItems, reorder, select, beginRename, cancelRename,
  renameKey, showContext, contextAction, onKeydown,
} = useActivityNavigation(props, emit, { root: strip })
</script>
<style scoped>
.main-tab.drop-before {
  box-shadow: inset 1px 0 var(--color-accent);
}
.main-tab.drop-after {
  box-shadow: inset -1px 0 var(--color-accent);
}
.tab-name-input {
  position: absolute;
  inset: 2px 28px 2px 8px;
  width: calc(100% - 36px);
  min-width: 0;
}
</style>
