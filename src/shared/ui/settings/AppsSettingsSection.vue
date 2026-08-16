<template>
  <section
    ref="root"
    data-apps-settings
    aria-label="Local apps"
    class="font-sans text-ink"
    @keydown="onRootKeydown"
  >
    <header class="mb-3 flex items-center justify-between gap-3">
      <h2 class="section-title !mb-0">Local apps</h2>
      <div class="flex items-center gap-1">
        <button
          ref="newButton"
          type="button"
          data-app-new
          class="h-8 border border-rule px-3 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="openCreate"
        >
          New app
        </button>
        <div data-app-menu class="relative">
          <button
            type="button"
            data-apps-more
            aria-label="More app actions"
            :aria-expanded="openMenu === 'global'"
            class="grid size-8 place-items-center text-[15px] tracking-[0.08em] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="toggleMenu('global')"
          >
            ···
          </button>
          <div
            v-if="openMenu === 'global'"
            role="menu"
            class="absolute right-0 top-9 z-20 min-w-40 border border-rule bg-surface py-1 shadow-lg"
            @keydown.esc.stop.prevent="closeMenu"
          >
            <MenuButton data-apps-refresh @click="reload">Reload apps</MenuButton>
            <MenuButton data-apps-reveal-directory @click="revealDirectory">Open apps folder</MenuButton>
          </div>
        </div>
      </div>
    </header>

    <form
      v-if="operation"
      data-app-operation
      class="mb-4 border-y border-rule-light py-3"
      @submit.prevent="submitOperation"
    >
      <div class="flex items-center gap-2">
        <input
          ref="operationInput"
          v-model="draftTitle"
          data-app-title-input
          :aria-label="operation === 'create' ? 'App name' : 'New app name'"
          :placeholder="operation === 'create' ? 'App name' : 'New name'"
          autocomplete="off"
          maxlength="120"
          class="h-8 min-w-0 flex-1 border border-rule bg-surface px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
        >
        <button
          type="submit"
          data-app-operation-confirm
          :disabled="busy || !draftTitle.trim()"
          class="h-8 border border-rule px-3 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-40"
        >
          {{ busy ? 'Working…' : operation === 'create' ? 'Create' : 'Save' }}
        </button>
        <button
          type="button"
          class="h-8 px-2 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
          @click="closeOperation"
        >
          Cancel
        </button>
      </div>
      <p v-if="error" role="alert" class="mt-2 text-[11px] text-rem">{{ error }}</p>
    </form>

    <div v-if="catalog.loading && !catalog.loaded" class="py-8 text-center text-[11px] text-ink-3">
      Loading…
    </div>

    <div v-else-if="!catalog.loaded && error" class="border-y border-rule-light py-4">
      <p role="alert" class="text-[11px] text-rem">{{ error }}</p>
      <button
        type="button"
        data-app-load-retry
        :disabled="busy"
        class="mt-3 h-8 border border-rule px-3 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink disabled:opacity-40"
        @click="retryLoad"
      >
        Retry
      </button>
    </div>

    <template v-else>
      <p v-if="error || catalog.error" role="alert" class="mb-3 text-[11px] text-rem">
        {{ error || catalog.error }}
      </p>

      <div v-if="catalog.localApps.length || diagnostics.length" class="border-t border-rule-light">
        <div
          v-for="app in catalog.localApps"
          :key="app.id"
          :data-app-settings-row="app.id"
          class="flex min-h-11 items-center gap-1 border-b border-rule-light"
        >
          <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-2">{{ app.title }}</span>
          <button
            type="button"
            data-app-launch
            :disabled="busy"
            class="h-8 px-2.5 text-[11px] font-medium text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            @click="launch(app)"
          >
            Open
          </button>
          <button
            type="button"
            data-app-open-definition
            class="h-8 px-2.5 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('openDefinition', app.manifestPath)"
          >
            Edit
          </button>
          <div data-app-menu class="relative">
            <button
              type="button"
              data-app-more
              :aria-label="`More actions for ${app.title}`"
              :aria-expanded="openMenu === `app:${app.id}`"
              class="grid size-8 place-items-center text-[15px] tracking-[0.08em] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="toggleMenu(`app:${app.id}`)"
            >
              ···
            </button>
            <div
              v-if="openMenu === `app:${app.id}`"
              role="menu"
              class="absolute right-0 top-9 z-20 min-w-40 border border-rule bg-surface py-1 shadow-lg"
              @keydown.esc.stop.prevent="closeMenu"
            >
              <MenuButton data-app-rename @click="openRename(app)">Rename</MenuButton>
              <MenuButton data-app-duplicate @click="duplicate(app)">Duplicate</MenuButton>
              <MenuButton data-app-reveal @click="revealDefinition(app)">Show in Finder</MenuButton>
              <div class="my-1 border-t border-rule-light" />
              <MenuButton data-app-trash class="text-rem hover:text-rem" @click="trash(app)">Move to Trash</MenuButton>
            </div>
          </div>
        </div>

        <div
          v-for="diagnostic in diagnostics"
          :key="diagnostic.key"
          data-app-diagnostic-row
          class="flex min-h-12 items-center gap-2 border-b border-rule-light py-1.5"
        >
          <div class="min-w-0 flex-1">
            <div class="truncate text-[12px] font-medium text-ink-2">{{ diagnostic.name }}</div>
            <div class="truncate text-[10px] text-rem">{{ diagnostic.message }}</div>
          </div>
          <button
            v-if="isManifestPath(diagnostic.path)"
            type="button"
            data-app-diagnostic-open
            class="h-8 shrink-0 px-2.5 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="$emit('openDefinition', diagnostic.path)"
          >
            Open file
          </button>
          <button
            v-else
            type="button"
            data-app-diagnostic-reveal
            class="h-8 shrink-0 px-2.5 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="revealPath(diagnostic.path)"
          >
            Open folder
          </button>
          <button
            type="button"
            data-app-diagnostic-reload
            :disabled="busy"
            class="h-8 shrink-0 px-2.5 text-[11px] text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-40"
            @click="reload"
          >
            Reload
          </button>
        </div>
      </div>

      <p v-else class="border-y border-rule-light py-8 text-center text-[11px] text-ink-3">
        No local apps.
      </p>
    </template>

    <p v-if="notice" class="sr-only" role="status">{{ notice }}</p>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { useAppsCatalogStore } from '../../../stores/appsCatalog.js'
import { revealAppDefinition, revealAppsDirectory } from '../../../services/appsCatalog.js'

const emit = defineEmits(['launchApp', 'openDefinition'])

const MenuButton = defineComponent({
  setup(_, { attrs, slots }) {
    return () => h('button', {
      ...attrs,
      type: 'button',
      role: 'menuitem',
      class: [
        'block h-8 w-full px-3 text-left text-[11px] text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
        attrs.class,
      ],
    }, slots.default?.())
  },
})

const settings = useSettingsStore()
const catalog = useAppsCatalogStore()
const root = ref(null)
const newButton = ref(null)
const operationInput = ref(null)
const operation = ref('')
const operationAppId = ref('')
const draftTitle = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const openMenu = ref('')

const diagnostics = computed(() => catalog.diagnostics.map((diagnostic, index) => ({
  ...diagnostic,
  key: `diagnostic:${index}:${diagnostic.path}:${diagnostic.message}`,
  name: diagnosticName(diagnostic.path),
})))

onMounted(async () => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  try {
    await catalog.load()
  } catch (cause) {
    error.value = errorMessage(cause)
  }
})

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

function focusInitial() {
  nextTick(() => newButton.value?.focus())
}

async function launch(app) {
  if (!app || busy.value) return
  await runAction(async () => {
    const payload = await catalog.prepareActivity(app, String(settings.mimirWorkspaceFolder || ''))
    emit('launchApp', payload)
  })
}

function openCreate() {
  operation.value = 'create'
  operationAppId.value = ''
  draftTitle.value = ''
  error.value = ''
  notice.value = ''
  openMenu.value = ''
  focusOperation()
}

function openRename(app) {
  operation.value = 'rename'
  operationAppId.value = app.id
  draftTitle.value = app.title
  error.value = ''
  notice.value = ''
  openMenu.value = ''
  focusOperation(true)
}

function closeOperation() {
  operation.value = ''
  operationAppId.value = ''
  error.value = ''
  focusInitial()
}

function focusOperation(select = false) {
  nextTick(() => {
    operationInput.value?.focus()
    if (select) operationInput.value?.select()
  })
}

async function submitOperation() {
  const title = draftTitle.value.trim()
  if (!title || busy.value) return
  if (operation.value === 'create') {
    const id = uniqueId(title)
    const succeeded = await runAction(() => catalog.create({ id, title, description: '' }))
    if (succeeded) notice.value = `${title} created.`
  } else if (operation.value === 'rename' && operationAppId.value) {
    const succeeded = await runAction(() => catalog.updateTitle(operationAppId.value, title))
    if (succeeded) notice.value = `${title} saved.`
  }
  if (notice.value) {
    operation.value = ''
    operationAppId.value = ''
  }
}

async function duplicate(app) {
  openMenu.value = ''
  const title = `${app.title} Copy`
  const id = uniqueId(`${app.id}-copy`)
  const succeeded = await runAction(() => catalog.duplicate(app.id, { id, title }))
  if (succeeded) notice.value = `${title} created.`
}

async function trash(app) {
  openMenu.value = ''
  const succeeded = await runAction(() => catalog.trash(app.id))
  if (succeeded) notice.value = `${app.title} moved to Trash.`
}

async function reload() {
  openMenu.value = ''
  await runAction(() => catalog.reload())
}

async function retryLoad() {
  await runAction(() => catalog.load({ force: true }))
}

async function revealDirectory() {
  openMenu.value = ''
  await runAction(() => revealAppsDirectory(catalog.directory))
}

async function revealDefinition(app) {
  openMenu.value = ''
  await runAction(() => revealAppDefinition(app))
}

async function revealPath(path) {
  await runAction(() => revealAppsDirectory(path))
}

async function runAction(action) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
    return true
  } catch (cause) {
    error.value = errorMessage(cause)
    return false
  } finally {
    busy.value = false
  }
}

function toggleMenu(key) {
  openMenu.value = openMenu.value === key ? '' : key
}

function closeMenu() {
  openMenu.value = ''
}

function onDocumentPointerDown(event) {
  if (openMenu.value && !event.target?.closest?.('[data-app-menu]')) closeMenu()
}

function onRootKeydown(event) {
  if (event.key === 'Escape' && openMenu.value) {
    event.preventDefault()
    event.stopPropagation()
    closeMenu()
    return
  }
  if (event.key === 'Escape' && operation.value) {
    event.preventDefault()
    event.stopPropagation()
    closeOperation()
  }
}

function uniqueId(value) {
  const base = String(value || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'app'
  const ids = new Set(catalog.apps.map(app => app.id))
  if (!ids.has(base)) return base
  let index = 2
  while (ids.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

function diagnosticName(path) {
  const parts = String(path || 'App definition').replaceAll('\\', '/').split('/').filter(Boolean)
  const file = parts.at(-1) || 'App definition'
  if (file === 'app.toml') return parts.at(-2) || file
  return file.replace(/\.toml$/i, '')
}

function isManifestPath(path) {
  return /\.toml$/i.test(String(path || ''))
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'App action failed.')
}

defineExpose({ focusInitial })
</script>
