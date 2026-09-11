<template>
  <WorkbenchMenu
    :label="label"
    :items="items"
    :action="{ id: 'new', label: 'New tab', detail: '⌘T' }"
    searchable
    @select="$emit('select', $event)"
    @action="$emit('new')"
  ><IconChevronDown :size="15" :stroke-width="1.8" /><span
    v-if="items.some(item => ['Error', 'Needs input', 'Unread'].includes(item.detail))"
    :aria-label="label === 'All tabs' ? 'Tabs need attention' : 'Activities need attention'"
  >!</span></WorkbenchMenu>
</template>

<script setup>
import { computed } from 'vue'
import { IconChevronDown } from '@tabler/icons-vue'
import WorkbenchMenu from './WorkbenchMenu.vue'
import { activityNavigationStatus } from '../composables/useActivityNavigation.js'

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  blockingIds: { type: Set, default: () => new Set() },
  restoringIds: { type: Set, default: () => new Set() },
  label: { type: String, default: 'All tabs' },
})
defineEmits(['select', 'new'])
const items = computed(() => props.tabs.map(tab => ({
  id: tab.id,
  label: tab.title,
  detail: activityNavigationStatus(tab, props),
  active: tab.id === props.activeId,
})))
</script>
