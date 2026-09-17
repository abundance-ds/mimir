<template>
  <header data-graph-topbar class="graph-topbar pane-bar">
    <nav class="graph-sections" aria-label="Business graph sections">
      <button
        v-for="item in sections"
        :key="item.id"
        type="button"
        :data-graph-section="item.id"
        :data-graph-control="`section-${item.id}`"
        class="graph-section"
        :class="{ 'graph-section-active': section === item.id }"
        :aria-current="section === item.id ? 'page' : undefined"
        @click="$emit('setSection', item.id)"
      >
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <div class="graph-search">
      <IconSearch :size="14" aria-hidden="true" />
      <input
        ref="searchInput"
        :value="searchValue"
        data-graph-search
        data-graph-control="global-search"
        type="search"
        :placeholder="section === 'work' ? 'Filter work…' : 'Search entries…'"
        :aria-label="section === 'work' ? 'Filter work' : 'Search the business graph'"
        :title="section === 'work' ? 'Filter by title, project, owner, tags, or work details' : 'Search graph content'"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        @input="$emit('update:searchValue', $event.target.value)"
        @keydown.down.prevent="$emit('focusSearchResults', 'first')"
        @keydown.up.prevent="$emit('focusSearchResults', 'last')"
        @keydown.enter.prevent="$emit('flushSearch')"
        @keydown.esc="$emit('searchEscape', $event)"
      />
      <span
        v-if="searchPending || searching"
        class="graph-searching"
        role="status"
        aria-label="Searching the graph"
      />
      <span
        v-else-if="searchQuery"
        class="graph-search-count"
        role="status"
        :aria-label="`${resultCount} search ${resultCount === 1 ? 'result' : 'results'} in ${sectionLabel || 'this section'}`"
      >
        {{ resultCount }}
      </span>
      <button
        v-if="searchValue"
        type="button"
        data-graph-control="clear-search"
        class="graph-search-clear"
        aria-label="Clear graph search"
        @click="$emit('clearSearch')"
      >
        <IconX :size="13" />
      </button>
      <kbd v-else>⌘F</kbd>
    </div>

    <div class="graph-actions">
      <div ref="scopeRoot" class="relative" data-graph-scope-root>
        <button
          ref="scopeTrigger"
          type="button"
          data-graph-scope-trigger
          data-graph-control="scope-trigger"
          class="graph-scope-trigger"
          :aria-label="`Scopes: ${scopeSummary}`"
          :title="`Scopes: ${scopeSummary}`"
          :aria-expanded="scopeMenu"
          aria-haspopup="menu"
          @click="toggleScopeMenu"
          @keydown.down.prevent="openScopeMenu('first')"
          @keydown.up.prevent="openScopeMenu('last')"
        >
          <IconStack :size="14" class="graph-scope-icon" aria-hidden="true" />
          <span>{{ scopeSummary }}</span>
          <IconChevronDown :size="12" />
        </button>
        <div
          v-if="scopeMenu"
          ref="scopeMenuRoot"
          data-graph-scope-menu
          role="menu"
          aria-label="Graph scopes"
          class="graph-scope-menu"
          @keydown="onScopeMenuKeydown"
        >
          <button
            v-for="scope in scopes"
            :key="scope.id"
            type="button"
            role="menuitemcheckbox"
            :aria-checked="activeScopeIds.includes(scope.id)"
            :data-scope-option="scope.id"
            :data-graph-control="`scope-${scope.id}`"
            class="graph-scope-option"
            :title="scope.root"
            @click="$emit('toggleScope', scope.id)"
          >
            <span
              class="graph-checkbox"
              :class="{ 'graph-checkbox-checked': activeScopeIds.includes(scope.id) }"
            >
              <IconCheck v-if="activeScopeIds.includes(scope.id)" :size="11" />
            </span>
            <span class="graph-scope-copy">{{ scopeName(scope.kind) }}</span>
            <span class="graph-scope-count">{{ scopeCounts[scope.id] || 0 }}</span>
          </button>
        </div>
      </div>

      <button
        type="button"
        data-graph-refresh
        data-graph-control="refresh"
        class="graph-icon-button"
        title="Refresh graph"
        aria-label="Refresh graph"
        :disabled="refreshing"
        @click="$emit('refresh')"
      >
        <IconRefresh :size="15" :class="{ 'motion-safe:animate-spin': refreshing }" />
      </button>
      <button
        type="button"
        data-graph-create
        data-graph-control="create"
        class="graph-primary-button"
        title="Create graph item (N)"
        @click="$emit('create')"
      >
        <IconPlus :size="15" />
        <span>New</span>
      </button>
    </div>
  </header>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconCheck,
  IconChevronDown,
  IconStack,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-vue'

const props = defineProps({
  sections: { type: Array, required: true },
  section: { type: String, required: true },
  sectionLabel: { type: String, default: '' },
  searchValue: { type: String, default: '' },
  searchQuery: { type: String, default: '' },
  searchPending: { type: Boolean, default: false },
  searching: { type: Boolean, default: false },
  resultCount: { type: Number, default: 0 },
  scopes: { type: Array, default: () => [] },
  activeScopeIds: { type: Array, default: () => [] },
  scopeCounts: { type: Object, default: () => ({}) },
  refreshing: { type: Boolean, default: false },
})

defineEmits([
  'setSection',
  'update:searchValue',
  'focusSearchResults',
  'flushSearch',
  'searchEscape',
  'clearSearch',
  'toggleScope',
  'refresh',
  'create',
])

const searchInput = ref(null)
const scopeRoot = ref(null)
const scopeTrigger = ref(null)
const scopeMenuRoot = ref(null)
const scopeMenu = ref(false)
const scopeSummary = computed(() => {
  if (!props.scopes.length) return 'No scopes'
  if (props.activeScopeIds.length === props.scopes.length) return 'All scopes'
  const selected = props.scopes.filter(scope => props.activeScopeIds.includes(scope.id))
  if (selected.length === 1) return scopeName(selected[0].kind)
  return `${props.activeScopeIds.length} scopes`
})

function focusSearch({ select = false } = {}) {
  searchInput.value?.focus()
  if (select) searchInput.value?.select()
}

function toggleScopeMenu() {
  scopeMenu.value = !scopeMenu.value
}

async function openScopeMenu(edge = 'first') {
  scopeMenu.value = true
  await nextTick()
  focusMenuEdge(scopeMenuRoot.value, edge)
}

function closeMenus({ restoreFocus = false } = {}) {
  if (!scopeMenu.value) return false
  scopeMenu.value = false
  if (restoreFocus) void nextTick(() => scopeTrigger.value?.focus())
  return true
}

function onScopeMenuKeydown(event) {
  const items = menuItems(scopeMenuRoot.value)
  const current = items.indexOf(document.activeElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenus({ restoreFocus: true })
  } else if (items.length && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
  } else if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const index = current < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : (current + delta + items.length) % items.length
    items[index]?.focus()
  }
}

function focusMenuEdge(root, edge) {
  const items = menuItems(root)
  items[edge === 'last' ? items.length - 1 : 0]?.focus()
}

function menuItems(root) {
  return [...(root?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])]
}

function scopeName(value) {
  if (value === 'project') return 'Workspace'
  const label = String(value || '').replaceAll('-', ' ')
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : ''
}

function onDocumentPointerDown(event) {
  if (scopeMenu.value && !scopeRoot.value?.contains(event.target)) closeMenus()
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

defineExpose({ closeMenus, focusSearch })
</script>

<style scoped>
.graph-topbar {
  display: grid;
  z-index: 20;
  grid-template-columns: minmax(0, 1fr) minmax(190px, 320px) auto;
  gap: 10px;
}

.graph-sections,
.graph-actions,
.graph-search,
.graph-scope-trigger {
  display: flex;
  align-items: center;
}

.graph-sections { min-width: 0; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.graph-sections::-webkit-scrollbar { display: none; }
.graph-section { display: inline-flex; min-height: 26px; flex: 0 0 auto; align-items: center; border-radius: 3px; padding: 0 7px; color: var(--color-ink-3); font-size: 10.5px; font-weight: 540; transition: background-color 120ms ease, color 120ms ease; }
.graph-section:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-section-active { background: transparent; color: var(--color-ink); font-weight: 700; }

.graph-search { position: relative; height: 28px; min-width: 0; gap: 7px; border: 1px solid var(--color-rule-light); border-radius: 5px; background: var(--graph-canvas); padding: 0 7px 0 9px; color: var(--color-ink-4); transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease; }
.graph-search:focus-within { border-color: color-mix(in srgb, var(--color-accent) 62%, var(--color-rule)); background: var(--graph-raised); box-shadow: 0 0 0 2px var(--graph-focus); }
.graph-search input { width: 100%; min-width: 0; border: 0; outline: 0; appearance: none; background: transparent; color: var(--color-ink); font-size: 11px; }
.graph-search input::-webkit-search-cancel-button { display: none; }
.graph-search input::placeholder { color: var(--color-ink-4); }
.graph-search kbd { display: grid; min-width: 25px; height: 18px; flex: 0 0 auto; place-items: center; border: 1px solid var(--color-rule-light); border-radius: 4px; color: var(--color-ink-4); font-family: var(--font-mono); font-size: 9px; }
.graph-searching { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--color-accent); animation: graph-pulse 700ms ease-in-out infinite alternate; }
.graph-search-count { min-width: 13px; flex: 0 0 auto; color: var(--color-ink-4); font-family: var(--font-mono); font-size: 9px; font-variant-numeric: tabular-nums; text-align: right; }
.graph-search-clear { display: grid; width: 22px; height: 22px; flex: 0 0 auto; place-items: center; border-radius: 4px; color: var(--color-ink-4); }
.graph-search-clear:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-actions { gap: 5px; }
.graph-icon-button { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 5px; color: var(--color-ink-3); }
.graph-icon-button:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-icon-button:disabled { cursor: default; opacity: 0.42; }
.graph-primary-button { display: inline-flex; min-height: 28px; align-items: center; justify-content: center; gap: 5px; border-radius: 5px; background: var(--color-accent); padding: 0 9px; color: var(--color-accent-ink, white); font-size: 11px; font-weight: 650; }
.graph-primary-button:hover { background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink)); }
.graph-scope-trigger { height: 28px; gap: 7px; border-radius: 5px; padding: 0 8px; color: var(--color-ink-3); font-size: 10px; font-weight: 540; }
.graph-scope-icon { display: none; }
.graph-scope-trigger:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-section:focus-visible, .graph-icon-button:focus-visible, .graph-primary-button:focus-visible, .graph-scope-trigger:focus-visible, .graph-search-clear:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: 1px; }

.graph-scope-menu { position: absolute; z-index: 90; top: 38px; right: 0; width: min(220px, calc(100cqw - 24px)); border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); padding: 5px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.graph-scope-option { display: grid; width: 100%; min-height: 34px; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 7px; border-radius: 5px; padding: 4px 8px; text-align: left; }
.graph-scope-option:hover, .graph-scope-option:focus-visible { background: var(--graph-hover); outline: none; }
.graph-checkbox { display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid var(--color-rule); border-radius: 4px; color: transparent; }
.graph-checkbox-checked { border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); }
.graph-scope-copy { min-width: 0; overflow: hidden; color: var(--color-ink-2); font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.graph-scope-count { color: var(--color-ink-4); font-family: var(--font-mono); font-size: 10px; }

@keyframes graph-pulse { to { opacity: 0.35; transform: scale(0.8); } }
@container business-graph (max-width: 1050px) {
  .graph-topbar { grid-template-columns: minmax(140px, 1fr) minmax(150px, 240px) auto; }
}
@container business-graph (max-width: 680px) {
  .graph-topbar { grid-template-columns: minmax(140px, 1fr) minmax(96px, 180px) auto; gap: 7px; }
  .graph-search kbd { display: none; }
  .graph-primary-button { width: 28px; padding: 0; }
  .graph-primary-button span { display: none; }
}
@container business-graph (max-width: 419px) {
  .graph-topbar { grid-template-columns: auto minmax(80px, 1fr) auto; gap: 5px; }
  .graph-section { padding-inline: 8px; }
  .graph-scope-trigger { width: 28px; justify-content: center; padding: 0; }
  .graph-scope-trigger span, .graph-scope-trigger > svg:last-child { display: none; }
  .graph-scope-icon { display: block; }
}
</style>
