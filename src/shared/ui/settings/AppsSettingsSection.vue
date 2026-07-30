<template>
  <section
    ref="root"
    data-apps-settings
    aria-label="Apps settings"
    class="flex h-full min-h-0 flex-col bg-surface text-ink"
    @keydown="onCatalogKeydown"
  >
    <header class="shrink-0 border-b border-rule-light bg-chrome-high px-4 py-3">
      <div class="flex items-center gap-2">
        <label
          class="flex h-8 min-w-0 flex-1 items-center gap-2 border border-rule bg-surface px-2.5 focus-within:border-accent"
        >
          <IconSearch :size="13" :stroke-width="1.7" class="shrink-0 text-ink-4" />
          <input
            ref="searchInput"
            v-model="query"
            data-app-search
            type="search"
            autocomplete="off"
            placeholder="Find an app, mode, tool, or id"
            class="min-w-0 flex-1 border-0 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-4"
            @keydown.down.prevent="focusSelectedRow(1)"
            @keydown.up.prevent="focusSelectedRow(-1)"
          >
          <span class="font-mono text-[8px] tabular-nums text-ink-4">
            {{ filteredApps.length }}/{{ catalog.apps.length }}
          </span>
        </label>
        <button
          type="button"
          data-app-new
          class="flex h-8 shrink-0 items-center gap-1.5 border border-rule bg-surface px-2.5 text-[10px] font-semibold text-ink-2 hover:border-accent/50 hover:bg-accent-soft hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="openCreate"
        >
          <IconPlus :size="13" :stroke-width="1.8" />
          New
        </button>
        <button
          type="button"
          data-apps-reveal-directory
          title="Reveal ~/.mimir/apps"
          aria-label="Reveal apps directory"
          :disabled="!catalog.directory"
          class="grid size-8 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-35"
          @click="revealDirectory"
        >
          <IconFolderOpen :size="14" :stroke-width="1.7" />
        </button>
        <button
          type="button"
          data-apps-refresh
          title="Reload app definitions"
          aria-label="Reload app definitions"
          :disabled="busy || catalog.loading"
          class="grid size-8 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-35"
          @click="reload"
        >
          <IconRefresh
            :size="14"
            :stroke-width="1.7"
            :class="{ 'motion-safe:animate-spin': catalog.loading }"
          />
        </button>
      </div>
      <div class="mt-2 flex items-center gap-2 font-mono text-[8px] text-ink-4">
        <span class="size-1.5 rounded-full" :class="catalog.diagnostics.length ? 'bg-rem' : 'bg-add'" />
        <span>
          {{ catalog.localApps.length }} local · {{ catalog.builtins.length }} built in
          <template v-if="catalog.diagnostics.length"> · {{ catalog.diagnostics.length }} problem{{ catalog.diagnostics.length === 1 ? '' : 's' }}</template>
        </span>
        <span class="ml-auto min-w-0 truncate">{{ catalog.directory || '~/.mimir/apps' }}</span>
      </div>
    </header>

    <form
      v-if="operation"
      data-app-operation
      class="shrink-0 border-b px-4 py-3"
      :class="operation === 'trash' ? 'border-rem/25 bg-rem/5' : 'border-accent/20 bg-accent-soft/40'"
      @submit.prevent="submitOperation"
    >
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-[11px] font-semibold">{{ operationTitle }}</p>
          <p class="mt-0.5 text-[9px] leading-relaxed text-ink-3">{{ operationDetail }}</p>
        </div>
        <button
          type="button"
          aria-label="Cancel app action"
          class="grid size-6 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
          @click="closeOperation"
        >
          <IconX :size="13" />
        </button>
      </div>

      <div v-if="operation !== 'trash'" class="mt-3 grid grid-cols-2 gap-2">
        <label v-if="operation !== 'rename'" class="min-w-0">
          <span class="mb-1 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">Stable id</span>
          <input
            ref="operationInput"
            v-model.trim="draft.id"
            data-app-id-input
            required
            maxlength="64"
            pattern="[A-Za-z0-9_-]+"
            class="h-8 w-full border border-rule bg-surface px-2 font-mono text-[10px] text-ink outline-none focus:border-accent"
          >
        </label>
        <label class="min-w-0" :class="{ 'col-span-2': operation === 'rename' }">
          <span class="mb-1 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">Display title</span>
          <input
            :ref="operation === 'rename' ? setOperationInput : undefined"
            v-model.trim="draft.title"
            data-app-title-input
            required
            maxlength="120"
            class="h-8 w-full border border-rule bg-surface px-2 text-[10px] text-ink outline-none focus:border-accent"
          >
        </label>
        <label v-if="operation === 'create'" class="col-span-2 min-w-0">
          <span class="mb-1 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">Purpose <span class="normal-case tracking-normal text-ink-4">optional</span></span>
          <input
            v-model.trim="draft.description"
            data-app-description-input
            maxlength="500"
            class="h-8 w-full border border-rule bg-surface px-2 text-[10px] text-ink outline-none focus:border-accent"
            placeholder="What this local instrument is for"
          >
        </label>
      </div>

      <div class="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          class="h-7 px-2.5 text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid hover:text-ink"
          @click="closeOperation"
        >
          Cancel
        </button>
        <button
          type="submit"
          data-app-operation-confirm
          :disabled="busy"
          class="h-7 border px-3 text-[9px] font-semibold focus-visible:outline-none focus-visible:ring-1 disabled:opacity-40"
          :class="operation === 'trash'
            ? 'border-rem/40 text-rem hover:bg-rem/10 focus-visible:ring-rem'
            : 'border-accent/40 bg-accent text-accent-ink hover:bg-accent-2 focus-visible:ring-accent'"
        >
          {{ busy ? 'Working…' : operationAction }}
        </button>
      </div>
    </form>

    <div
      v-if="error || catalog.error"
      data-apps-error
      role="alert"
      class="flex shrink-0 items-start gap-2 border-b border-rem/25 bg-rem/5 px-4 py-2 text-[10px] text-rem"
    >
      <IconAlertTriangle :size="13" :stroke-width="1.7" class="mt-px shrink-0" />
      <span class="min-w-0 flex-1">{{ error || catalog.error }}</span>
      <button type="button" class="font-semibold" @click="error = ''">Dismiss</button>
    </div>
    <div
      v-else-if="notice"
      data-apps-notice
      role="status"
      class="shrink-0 border-b border-add/20 bg-add/5 px-4 py-2 text-[9px] text-ink-2"
    >
      {{ notice }}
    </div>

    <div v-if="catalog.loading && !catalog.loaded" class="grid min-h-0 flex-1 place-items-center">
      <div class="text-center">
        <span class="mx-auto block h-px w-16 bg-accent motion-safe:animate-pulse" />
        <p class="mt-3 font-mono text-[8px] uppercase tracking-[0.14em] text-ink-3">Reading local instruments</p>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto" data-apps-catalog>
      <AppSection
        v-if="filteredBuiltins.length"
        label="Built in"
        detail="Fast defaults"
        :apps="filteredBuiltins"
        :selected-id="selected?.id || ''"
        @select="select"
        @launch="launch"
      />
      <AppSection
        v-if="filteredLocal.length"
        label="Local"
        detail="Hackable definitions"
        :apps="filteredLocal"
        :selected-id="selected?.id || ''"
        @select="select"
        @launch="launch"
      />

      <div
        v-if="!filteredApps.length"
        data-apps-empty
        class="mx-4 my-5 border border-dashed border-rule px-5 py-6 text-center"
      >
        <IconApps :size="20" :stroke-width="1.4" class="mx-auto text-ink-4" />
        <p class="mt-3 text-[11px] font-semibold">
          {{ query ? 'No matching instruments' : 'Your local bench is open' }}
        </p>
        <p class="mx-auto mt-1 max-w-sm text-[10px] leading-relaxed text-ink-3">
          {{ query
            ? 'Try an id, mode, or tool name.'
            : 'Create a working local app scaffold, then bend the HTML and manifest into exactly what you need.' }}
        </p>
        <button
          type="button"
          class="mt-3 h-7 border border-rule px-3 text-[9px] font-semibold hover:border-accent/50 hover:bg-accent-soft"
          @click="query ? query = '' : openCreate()"
        >
          {{ query ? 'Clear search' : 'Create first app' }}
        </button>
      </div>

      <section
        v-if="selected"
        data-app-inspector
        class="m-4 border border-rule bg-chrome-high"
      >
        <header class="flex items-start gap-3 border-b border-rule-light px-3 py-3">
          <span class="grid size-8 shrink-0 place-items-center border border-rule bg-surface text-ink-3">
            <IconTool :size="15" :stroke-width="1.6" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <h3 class="truncate text-[11px] font-semibold">{{ selected.title }}</h3>
              <span class="shrink-0 border border-rule bg-surface px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.1em] text-ink-3">
                {{ selected.builtin ? 'built in' : 'local' }}
              </span>
              <span class="shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">{{ selected.mode }}</span>
            </div>
            <p class="mt-1 text-[9px] leading-relaxed text-ink-3">{{ selected.description || 'No description yet.' }}</p>
          </div>
          <button
            type="button"
            data-app-launch
            :disabled="busy || (selected.id === 'tracker' && !tracker.enabled)"
            class="flex h-7 shrink-0 items-center gap-1.5 border border-accent/40 bg-accent px-2.5 text-[9px] font-semibold text-accent-ink hover:bg-accent-2 disabled:opacity-40"
            @click="launch(selected)"
          >
            <IconArrowUpRight :size="12" />
            {{ selected.id === 'tracker' && !tracker.enabled ? 'Enable to open' : 'Open' }}
          </button>
        </header>

        <TrackerSettingsPanel v-if="selected.id === 'tracker'" />

        <div class="grid grid-cols-[78px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-3 text-[9px]">
          <span class="font-mono uppercase tracking-[0.1em] text-ink-4">Stable id</span>
          <code class="truncate text-ink-2">{{ selected.id }}</code>
          <span class="font-mono uppercase tracking-[0.1em] text-ink-4">Definition</span>
          <code class="truncate text-ink-2">{{ selected.manifestPath }}</code>
          <span class="font-mono uppercase tracking-[0.1em] text-ink-4">Tools</span>
          <span class="text-ink-2">
            {{ selected.tools?.length
              ? selected.tools.map(tool => tool.mcpAlias || tool.mcp_alias || `${selected.id}_${tool.name}`).join(' · ')
              : 'None declared' }}
          </span>
        </div>

        <footer v-if="!selected.builtin" class="flex flex-wrap items-center gap-1 border-t border-rule-light px-2 py-2">
          <ActionButton data-app-open-definition @click="$emit('openDefinition', selected.manifestPath)">
            <IconFileCode :size="12" /> Open definition
          </ActionButton>
          <ActionButton data-app-reveal @click="revealDefinition(selected)">
            <IconFolderOpen :size="12" /> Reveal
          </ActionButton>
          <ActionButton data-app-duplicate @click="openDuplicate(selected)">
            <IconCopy :size="12" /> Duplicate
          </ActionButton>
          <ActionButton data-app-rename @click="openRename(selected)">
            <IconPencil :size="12" /> Rename
          </ActionButton>
          <ActionButton data-app-trash class="ml-auto text-rem hover:bg-rem/10" @click="openTrash(selected)">
            <IconTrash :size="12" /> Trash
          </ActionButton>
        </footer>
        <footer v-else class="border-t border-rule-light px-3 py-2 text-[8px] text-ink-4">
          Built-ins are host code. Duplicate local instruments instead of mutating these defaults.
        </footer>
      </section>

      <details
        v-if="catalog.diagnostics.length"
        data-app-diagnostics
        open
        class="m-4 border border-rem/25 bg-rem/5"
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-rem">
          Definition diagnostics · {{ catalog.diagnostics.length }}
        </summary>
        <div class="border-t border-rem/20">
          <article
            v-for="diagnostic in catalog.diagnostics"
            :key="`${diagnostic.path}:${diagnostic.field}:${diagnostic.message}`"
            class="flex items-start gap-2 border-b border-rem/15 px-3 py-2 last:border-b-0"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-[8px] text-rem/80">
                {{ diagnostic.path }}{{ diagnostic.field ? ` · ${diagnostic.field}` : '' }}
              </p>
              <p class="mt-1 text-[9px] leading-relaxed text-ink-2">{{ diagnostic.message }}</p>
            </div>
            <button
              type="button"
              title="Reveal definition"
              aria-label="Reveal definition problem"
              class="grid size-6 shrink-0 place-items-center text-ink-3 hover:bg-rem/10 hover:text-rem"
              @click="revealPath(diagnostic.path)"
            >
              <IconFolderOpen :size="12" />
            </button>
          </article>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onMounted, ref } from 'vue'
import {
  IconAlertTriangle,
  IconApps,
  IconArrowUpRight,
  IconCopy,
  IconFileCode,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTool,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { useAppsCatalogStore } from '../../../stores/appsCatalog.js'
import { useTrackerStore } from '../../../stores/tracker.js'
import {
  revealAppDefinition,
  revealAppsDirectory,
} from '../../../services/appsCatalog.js'
import AppSection from './AppSettingsSectionRows.vue'
import TrackerSettingsPanel from './TrackerSettingsPanel.vue'

const emit = defineEmits(['launchApp', 'openDefinition'])

const ActionButton = defineComponent({
  setup(_, { attrs, slots }) {
    return () => h('button', {
      ...attrs,
      type: 'button',
      class: [
        'flex h-7 items-center gap-1.5 px-2 text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        attrs.class,
      ],
    }, slots.default?.())
  },
})

const settings = useSettingsStore()
const catalog = useAppsCatalogStore()
const tracker = useTrackerStore()
const root = ref(null)
const searchInput = ref(null)
const operationInput = ref(null)
const query = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const operation = ref('')
const operationApp = ref(null)
const draft = ref({ id: '', title: '', description: '' })

const filteredApps = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return catalog.apps
  return catalog.apps.filter(app => [
    app.id,
    app.title,
    app.description,
    app.mode,
    ...(app.tools || []).flatMap(tool => [
      tool.name,
      tool.mcpAlias,
      tool.mcp_alias,
      tool.description,
    ]),
  ].some(value => String(value || '').toLowerCase().includes(needle)))
})
const filteredBuiltins = computed(() => filteredApps.value.filter(app => app.builtin))
const filteredLocal = computed(() => filteredApps.value.filter(app => !app.builtin))
const selected = computed(() => (
  filteredApps.value.find(app => app.id === catalog.selectedId)
  || filteredApps.value[0]
  || null
))
const operationTitle = computed(() => ({
  create: 'Create a working local instrument',
  duplicate: `Duplicate ${operationApp.value?.title || 'app'}`,
  rename: `Rename ${operationApp.value?.title || 'app'}`,
  trash: `Move ${operationApp.value?.title || 'app'} to Trash?`,
})[operation.value] || '')
const operationDetail = computed(() => ({
  create: 'Mimir writes a small autosaving HTML app, app.toml, and a live read tool. Open the files and make it yours.',
  duplicate: 'The local package and assets are copied. The new id gets its own data and MCP tool names.',
  rename: 'Only the display title changes. The stable id keeps app data, tools, and Activities connected.',
  trash: 'The exact local definition or package moves to the operating-system Trash. App data is kept.',
})[operation.value] || '')
const operationAction = computed(() => ({
  create: 'Create & select',
  duplicate: 'Duplicate',
  rename: 'Rename',
  trash: 'Move to Trash',
})[operation.value] || 'Apply')

onMounted(async () => {
  try {
    await catalog.load()
  } catch (cause) {
    error.value = errorMessage(cause)
  }
})

function focusInitial() {
  nextTick(() => searchInput.value?.focus())
}

function select(app) {
  catalog.select(app.id)
}

async function launch(app) {
  if (!app || busy.value) return
  busy.value = true
  error.value = ''
  try {
    catalog.select(app.id)
    const payload = await catalog.prepareActivity(app, String(settings.mimirWorkspaceFolder || ''))
    emit('launchApp', payload)
  } catch (cause) {
    error.value = `${app.title} could not open: ${errorMessage(cause)}`
  } finally {
    busy.value = false
  }
}

async function reload() {
  await runMutation(() => catalog.reload(), 'App definitions reloaded.')
}

async function revealDirectory() {
  try {
    await revealAppsDirectory(catalog.directory)
  } catch (cause) {
    error.value = errorMessage(cause)
  }
}

async function revealDefinition(app) {
  try {
    await revealAppDefinition(app)
  } catch (cause) {
    error.value = errorMessage(cause)
  }
}

async function revealPath(path) {
  try {
    await revealAppsDirectory(path)
  } catch (cause) {
    error.value = errorMessage(cause)
  }
}

function openCreate() {
  operation.value = 'create'
  operationApp.value = null
  draft.value = {
    id: uniqueId('local-instrument'),
    title: 'Local Instrument',
    description: '',
  }
  focusOperation()
}

function openDuplicate(app) {
  operation.value = 'duplicate'
  operationApp.value = app
  draft.value = {
    id: uniqueId(`${app.id}-copy`),
    title: `${app.title} Copy`,
    description: '',
  }
  focusOperation()
}

function openRename(app) {
  operation.value = 'rename'
  operationApp.value = app
  draft.value = { id: app.id, title: app.title, description: '' }
  focusOperation()
}

function openTrash(app) {
  operation.value = 'trash'
  operationApp.value = app
  draft.value = { id: app.id, title: app.title, description: '' }
}

function closeOperation() {
  operation.value = ''
  operationApp.value = null
  nextTick(() => searchInput.value?.focus())
}

function focusOperation() {
  nextTick(() => operationInput.value?.focus())
}

function setOperationInput(element) {
  operationInput.value = element
}

async function submitOperation() {
  const action = operation.value
  const app = operationApp.value
  if (!action || busy.value) return
  if (action !== 'trash' && !draft.value.title.trim()) {
    error.value = 'A display title is required.'
    return
  }
  if (['create', 'duplicate'].includes(action) && !/^[A-Za-z0-9_-]{1,64}$/.test(draft.value.id)) {
    error.value = 'The stable id accepts letters, numbers, hyphens, and underscores.'
    return
  }

  let success = ''
  const succeeded = await runMutation(async () => {
    if (action === 'create') {
      await catalog.create(draft.value)
      success = `${draft.value.title} is ready. Open its definition to keep shaping it.`
    } else if (action === 'duplicate') {
      await catalog.duplicate(app.id, draft.value)
      success = `${draft.value.title} was duplicated.`
    } else if (action === 'rename') {
      await catalog.updateTitle(app.id, draft.value.title)
      success = `Renamed to ${draft.value.title}.`
    } else if (action === 'trash') {
      await catalog.trash(app.id)
      success = `${app.title} moved to Trash.`
    }
  })
  if (succeeded) {
    notice.value = success
    closeOperation()
  }
}

async function runMutation(action, success) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
    notice.value = success
    return true
  } catch (cause) {
    error.value = errorMessage(cause)
    return false
  } finally {
    busy.value = false
  }
}

function uniqueId(base) {
  const normalized = String(base || 'local-instrument')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'local-instrument'
  const ids = new Set(catalog.apps.map(app => app.id))
  if (!ids.has(normalized)) return normalized
  let index = 2
  while (ids.has(`${normalized}-${index}`)) index += 1
  return `${normalized}-${index}`
}

function onCatalogKeydown(event) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape' && operation.value) {
    event.preventDefault()
    event.stopPropagation()
    closeOperation()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const tag = event.target?.tagName
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
  const catalogRow = event.target?.closest?.('[data-app-settings-row]')
  const onCatalogSurface = Boolean(catalogRow) || event.target === root.value
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!onCatalogSurface) return
    event.preventDefault()
    moveSelection(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter' && selected.value && onCatalogSurface) {
    event.preventDefault()
    void launch(selected.value)
  } else if (event.key === '/' && !operation.value) {
    event.preventDefault()
    searchInput.value?.focus()
  }
}

function moveSelection(delta) {
  if (!filteredApps.value.length) return
  const current = Math.max(0, filteredApps.value.findIndex(app => app.id === selected.value?.id))
  const index = (current + delta + filteredApps.value.length) % filteredApps.value.length
  catalog.select(filteredApps.value[index].id)
  focusSelectedRow()
}

function focusSelectedRow(delta = 0) {
  if (delta) moveSelection(delta)
  else nextTick(() => Array.from(
    root.value?.querySelectorAll('[data-app-settings-row]') || [],
  ).find(element => element.dataset.appSettingsRow === selected.value?.id)?.focus())
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'App operation failed.')
}

defineExpose({ focusInitial })
</script>
