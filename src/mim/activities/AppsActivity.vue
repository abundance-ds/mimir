<template>
  <section
    data-apps-activity
    class="flex h-full min-h-0 flex-col bg-chrome-high text-ink"
    @keydown.up.prevent="moveSelection(-1)"
    @keydown.down.prevent="moveSelection(1)"
    @keydown.enter.prevent="launchSelected"
  >
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-3">
      <div class="grid size-7 place-items-center border border-rule bg-surface text-ink-2">
        <IconApps :size="14" :stroke-width="1.7" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-[11px] font-semibold">Local instruments</p>
        <p class="truncate font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">
          {{ catalog.directory || 'Built-ins and ~/.mim/apps' }}
        </p>
      </div>
      <button
        type="button"
        data-apps-refresh
        title="Reload app definitions"
        aria-label="Reload app definitions"
        :disabled="catalog.loading"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="refresh"
      >
        <IconRefresh
          :size="13"
          :stroke-width="1.7"
          :class="{ 'motion-safe:animate-spin': catalog.loading }"
        />
      </button>
    </header>

    <div v-if="catalog.loading && !catalog.loaded" class="grid min-h-0 flex-1 place-items-center">
      <div class="text-center">
        <span class="mx-auto block h-px w-16 overflow-hidden bg-rule">
          <span class="block h-full w-1/2 bg-accent motion-safe:animate-pulse" />
        </span>
        <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">
          Reading app definitions
        </p>
      </div>
    </div>

    <div
      v-else-if="catalog.error"
      class="grid min-h-0 flex-1 place-items-center px-8 text-center"
      role="alert"
    >
      <div class="max-w-sm">
        <IconAlertTriangle :size="21" :stroke-width="1.5" class="mx-auto text-rem" />
        <p class="mt-3 text-[12px] font-semibold">App catalog unavailable</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ catalog.error }}</p>
        <button
          type="button"
          data-apps-retry
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="refresh"
        >
          Reload catalog
        </button>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto" data-apps-catalog>
      <AppGroup
        v-if="catalog.builtins.length"
        label="Pinned"
        detail="Ships with Mim"
        :apps="catalog.builtins"
        :selected-id="catalog.selectedApp?.id || ''"
        @select="catalog.select"
        @launch="launch"
      />
      <AppGroup
        v-if="catalog.localApps.length"
        label="Workbench"
        detail="Local definitions"
        :apps="catalog.localApps"
        :selected-id="catalog.selectedApp?.id || ''"
        @select="catalog.select"
        @launch="launch"
      />

      <div
        v-else
        data-apps-local-empty
        class="mx-3 mb-3 border border-dashed border-rule px-3 py-3"
      >
        <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
          Local slot open
        </p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-2">
          Add an <span class="font-mono">app.toml</span> below
          <span class="font-mono">{{ catalog.directory || '~/.mim/apps' }}</span>, then reload.
        </p>
      </div>

      <details
        v-if="catalog.diagnostics.length"
        data-app-diagnostics
        class="mx-3 mb-3 border border-rem/25 bg-rem/5"
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-rem">
          {{ catalog.diagnostics.length }} definition
          {{ catalog.diagnostics.length === 1 ? 'problem' : 'problems' }}
        </summary>
        <div class="border-t border-rem/20">
          <div
            v-for="diagnostic in catalog.diagnostics"
            :key="`${diagnostic.path}:${diagnostic.field}:${diagnostic.message}`"
            class="border-b border-rem/15 px-3 py-2 last:border-b-0"
          >
            <p class="break-all font-mono text-[8px] text-rem/80">
              {{ diagnostic.path }}{{ diagnostic.field ? ` · ${diagnostic.field}` : '' }}
            </p>
            <p class="mt-1 text-[10px] leading-relaxed text-ink-2">{{ diagnostic.message }}</p>
          </div>
        </div>
      </details>
    </div>

    <footer
      v-if="catalog.loaded && catalog.apps.length"
      class="flex h-10 shrink-0 items-center border-t border-rule bg-chrome-high px-3"
    >
      <p class="min-w-0 flex-1 truncate text-[10px] text-ink-3">
        {{ catalog.selectedApp?.description || 'Choose an app.' }}
      </p>
      <button
        type="button"
        data-apps-launch-selected
        :disabled="launching || !catalog.selectedApp"
        class="ml-3 flex h-7 shrink-0 items-center gap-1.5 border border-rule px-2.5 text-[9px] font-semibold hover:border-accent/50 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="launchSelected"
      >
        <IconArrowUpRight :size="12" :stroke-width="1.8" />
        {{ launching ? 'Opening…' : 'Open' }}
      </button>
    </footer>

    <div
      v-if="launchError"
      data-app-launch-error
      role="alert"
      class="shrink-0 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      {{ launchError }}
    </div>
  </section>
</template>

<script setup>
import { onMounted, watch, ref } from 'vue'
import {
  IconAlertTriangle,
  IconApps,
  IconArrowUpRight,
  IconRefresh,
} from '@tabler/icons-vue'
import { useAppsCatalogStore } from '../../stores/appsCatalog.js'
import AppGroup from '../apps/AppGroup.vue'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['launchApp', 'diagnostic'])
const catalog = useAppsCatalogStore()
const launching = ref(false)
const launchError = ref('')

onMounted(() => load())
watch(() => props.active, (active) => {
  if (active && !catalog.loaded) load()
})

async function load(force = false) {
  try {
    await catalog.load({ force })
  } catch (error) {
    emit('diagnostic', errorMessage(error))
  }
}

function refresh() {
  launchError.value = ''
  return load(true)
}

function moveSelection(delta) {
  if (!catalog.apps.length) return
  const current = Math.max(0, catalog.apps.findIndex((app) => app.id === catalog.selectedApp?.id))
  const index = (current + delta + catalog.apps.length) % catalog.apps.length
  catalog.select(catalog.apps[index].id)
}

function launchSelected() {
  if (catalog.selectedApp) return launch(catalog.selectedApp)
}

async function launch(app) {
  if (launching.value) return
  catalog.select(app.id)
  launching.value = true
  launchError.value = ''
  try {
    const payload = await catalog.prepareActivity(app, props.activity.workspacePath || '')
    emit('launchApp', payload)
  } catch (error) {
    launchError.value = `${app.title} could not open: ${errorMessage(error)}`
    emit('diagnostic', launchError.value)
  } finally {
    launching.value = false
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown app failure')
}
</script>
