<template>
  <section
    data-routines-activity
    class="routines-surface flex h-full min-h-0 flex-col bg-chrome-high text-ink"
  >
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-rule px-3">
      <div class="grid size-7 place-items-center border border-rule bg-surface text-ink-2">
        <IconCalendarClock :size="14" :stroke-width="1.65" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <p class="text-[11px] font-semibold">Scheduled instruments</p>
          <p
            v-if="routines.loaded"
            data-routines-summary
            class="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-3"
          >
            {{ routines.enabledCount }} armed<span v-if="routines.runningCount"> · {{ routines.runningCount }} running</span>
          </p>
        </div>
        <p
          class="truncate font-mono text-[8px] tracking-[0.03em] text-ink-3"
          :title="routines.directory"
        >
          {{ routines.directory || '~/.mim/routines' }}
        </p>
      </div>
      <button
        type="button"
        data-routines-reload
        title="Reload routine definitions"
        aria-label="Reload routine definitions"
        :disabled="routines.loading || routines.reloading"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="reload"
      >
        <IconRefresh
          :size="13"
          :stroke-width="1.7"
          :class="{ 'motion-safe:animate-spin': routines.loading || routines.reloading }"
        />
      </button>
    </header>

    <div v-if="routines.loading && !routines.loaded" class="grid min-h-0 flex-1 place-items-center">
      <div class="text-center">
        <span class="mx-auto block h-px w-16 overflow-hidden bg-rule">
          <span class="block h-full w-1/2 bg-accent motion-safe:animate-pulse" />
        </span>
        <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">
          Reading schedules
        </p>
      </div>
    </div>

    <div
      v-else-if="routines.error && !routines.loaded"
      data-routines-error
      class="grid min-h-0 flex-1 place-items-center px-8 text-center"
      role="alert"
    >
      <div class="max-w-sm">
        <IconAlertTriangle :size="21" :stroke-width="1.5" class="mx-auto text-rem" />
        <p class="mt-3 text-[12px] font-semibold">Routine runtime unavailable</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ routines.error }}</p>
        <button
          type="button"
          data-routines-retry
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="initialize"
        >
          Try again
        </button>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="routines.routines.length"
        data-routine-list
        role="listbox"
        :aria-activedescendant="routines.selectedRoutine ? `routine-${routines.selectedRoutine.id}` : undefined"
        tabindex="0"
        class="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.home.prevent="selectEdge('start')"
        @keydown.end.prevent="selectEdge('end')"
        @keydown.enter.prevent="runSelected"
      >
        <article
          v-for="routine in routines.routines"
          :id="`routine-${routine.id}`"
          :key="routine.id"
          :data-routine-row="routine.id"
          role="option"
          :aria-selected="routine.id === routines.selectedRoutine?.id"
          class="border-b border-rule-light"
          :class="{ 'bg-accent-soft': routine.id === routines.selectedRoutine?.id }"
        >
          <div class="routine-row-main grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2">
            <button
              type="button"
              :data-routine-select="routine.id"
              class="grid min-w-0 grid-cols-[8px_minmax(0,1fr)] items-start gap-2 text-left focus-visible:outline-none"
              @click="routines.select(routine.id)"
              @dblclick="run(routine)"
            >
              <span
                class="mt-[5px] block size-1.5"
                :class="{
                  'bg-rem': stateFor(routine).kind === 'error',
                  'bg-accent': stateFor(routine).kind === 'running',
                  'border border-ink-3': stateFor(routine).kind === 'paused',
                  'border border-dashed border-ink-3': stateFor(routine).kind === 'unavailable',
                  'bg-ink-3': stateFor(routine).kind === 'ready',
                }"
                aria-hidden="true"
              />
              <span class="min-w-0">
                <span class="flex min-w-0 items-baseline gap-2">
                  <span class="truncate text-[11px] font-semibold">{{ routine.title }}</span>
                  <span
                    class="shrink-0 font-mono text-[8px] uppercase tracking-[0.1em]"
                    :class="stateFor(routine).kind === 'error' ? 'text-rem' : stateFor(routine).kind === 'running' ? 'text-accent' : 'text-ink-3'"
                  >
                    {{ stateFor(routine).label }}
                  </span>
                </span>
                <span class="mt-0.5 flex min-w-0 items-center gap-2 text-[9px] text-ink-3">
                  <span class="truncate font-mono">{{ routine.schedule }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="shrink-0 font-mono">{{ routine.timezone }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="truncate">{{ routine.preset }}</span>
                </span>
              </span>
            </button>

            <div class="flex items-center gap-3">
              <div class="hidden min-w-24 text-right @[430px]:block">
                <p
                  class="font-mono text-[9px] tabular-nums text-ink-2"
                  :title="exactTime(routine.nextFire)"
                >
                  {{ nextFireLabel(routine) }}
                </p>
                <p class="mt-0.5 text-[8px] text-ink-3">next fire</p>
              </div>
              <button
                type="button"
                :data-routine-run="routine.id"
                :title="runTitle(routine)"
                :aria-label="`Run ${routine.title} now`"
                :disabled="Boolean(routines.pendingRuns[routine.id]) || !routine.available"
                class="flex h-7 min-w-16 items-center justify-center gap-1.5 border border-rule bg-surface px-2 text-[9px] font-semibold hover:border-accent/50 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                @click="run(routine)"
              >
                <IconPlayerPlay :size="11" :stroke-width="1.9" />
                {{ routines.pendingRuns[routine.id] ? 'Starting…' : 'Run now' }}
              </button>
            </div>
          </div>

          <div
            v-if="routine.id === routines.selectedRoutine?.id"
            :data-routine-detail="routine.id"
            class="routine-detail-grid grid gap-3 border-t border-rule-light bg-surface/55 px-5 py-3"
          >
            <div class="min-w-0">
              <p class="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">Prompt</p>
              <p class="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-ink-2">
                {{ routine.prompt }}
              </p>
            </div>
            <dl class="grid content-start grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[9px]">
              <dt class="text-ink-3">Workspace</dt>
              <dd class="truncate font-mono text-ink-2" :title="routine.workspace || activity.workspacePath || 'Launcher default'">
                {{ routine.workspace || activity.workspacePath || 'Launcher default' }}
              </dd>
              <dt class="text-ink-3">Overlap</dt>
              <dd class="text-ink-2">{{ policyLabel(routine.overlap) }}</dd>
              <dt class="text-ink-3">Missed</dt>
              <dd class="text-ink-2">{{ policyLabel(routine.missed) }}</dd>
              <dt class="text-ink-3">Next</dt>
              <dd class="font-mono text-ink-2">{{ exactTime(routine.nextFire) || 'Not scheduled' }}</dd>
            </dl>

            <p
              v-if="routine.diagnostic || routine.lastError || routines.runErrors[routine.id]"
              :data-routine-problem="routine.id"
              class="routine-problem col-span-full border-l border-rem bg-rem/5 px-3 py-2 text-[10px] leading-relaxed text-rem"
              role="status"
            >
              {{ routines.runErrors[routine.id] || routine.lastError || routine.diagnostic }}
            </p>
            <p
              v-else-if="routine.runningActivityIds.length"
              :data-routine-running="routine.id"
              class="col-span-full border-l border-accent bg-accent-soft px-3 py-2 text-[10px] text-ink-2"
            >
              {{ routine.runningActivityIds.length }}
              {{ routine.runningActivityIds.length === 1 ? 'run is' : 'runs are' }} live in the Activity tray.
            </p>
          </div>
        </article>
      </div>

      <div
        v-else
        data-routines-empty
        class="grid min-h-[300px] place-items-center px-8 py-10 text-center"
      >
        <div class="max-w-md">
          <IconCalendarPlus :size="22" :stroke-width="1.45" class="mx-auto text-ink-3" />
          <p class="mt-3 text-[12px] font-semibold">
            {{ routines.diagnostics.length ? 'No valid routines' : 'No routines yet' }}
          </p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
            Add a <span class="font-mono">.toml</span> definition to
            <span class="font-mono text-ink-2">{{ routines.directory || '~/.mim/routines' }}</span>,
            then reload. Each fire opens a normal agent Activity in the tray.
          </p>
          <pre class="mt-4 overflow-x-auto border border-rule bg-surface px-3 py-2 text-left font-mono text-[8px] leading-relaxed text-ink-3"><code>id = "morning-review"
title = "Morning review"
schedule = "0 0 9 * * Mon-Fri"
timezone = "Europe/Berlin"
preset = "codex"
prompt = "Review recent changes."</code></pre>
        </div>
      </div>

      <details
        v-if="routines.diagnostics.length"
        data-routine-diagnostics
        :open="!routines.routines.length"
        class="mx-3 my-3 border border-rem/25 bg-rem/5"
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-rem">
          {{ routines.diagnostics.length }} definition
          {{ routines.diagnostics.length === 1 ? 'problem' : 'problems' }}
        </summary>
        <div class="border-t border-rem/20">
          <div
            v-for="diagnostic in routines.diagnostics"
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
      v-if="routines.loaded"
      class="flex min-h-9 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3"
    >
      <p class="min-w-0 flex-1 truncate font-mono text-[8px] text-ink-3" :title="routines.statePath">
        {{ footerText }}
      </p>
      <p v-if="notice" data-routine-notice class="shrink-0 text-[9px] text-accent">
        {{ notice }}
      </p>
      <p v-else class="shrink-0 font-mono text-[8px] tabular-nums text-ink-3">
        rev {{ routines.revision }}
      </p>
    </footer>

    <div
      v-if="routines.error && routines.loaded"
      data-routines-inline-error
      role="alert"
      class="shrink-0 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      {{ routines.error }}
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconCalendarClock,
  IconCalendarPlus,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-vue'
import { useRoutinesStore } from '../../stores/routines.js'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['diagnostic'])
const routines = useRoutinesStore()
const notice = ref('')

const footerText = computed(() => (
  routines.statePath ? `planner · ${routines.statePath}` : 'Local scheduler · definitions stay on disk'
))

onMounted(() => initialize())
watch(() => props.active, (active) => {
  if (active && !routines.loaded) initialize()
})

async function initialize() {
  try {
    await routines.initialize()
  } catch (error) {
    emit('diagnostic', errorMessage(error))
  }
}

async function reload() {
  notice.value = ''
  try {
    await routines.reload()
    notice.value = 'Definitions reloaded'
  } catch (error) {
    emit('diagnostic', `Routines could not reload: ${errorMessage(error)}`)
  }
}

function moveSelection(delta) {
  notice.value = ''
  routines.moveSelection(delta)
}

function selectEdge(edge) {
  notice.value = ''
  routines.selectEdge(edge)
}

function runSelected() {
  if (routines.selectedRoutine) return run(routines.selectedRoutine)
}

async function run(routine) {
  if (!routine?.available || routines.pendingRuns[routine.id]) return
  routines.select(routine.id)
  notice.value = ''
  try {
    const result = await routines.runNow(routine.id)
    if (result) notice.value = `${routine.title} started`
  } catch (error) {
    emit('diagnostic', `${routine.title} did not start: ${errorMessage(error)}`)
  }
}

function stateFor(routine) {
  if (routines.pendingRuns[routine.id]) return { kind: 'running', label: 'Starting' }
  if (routines.runErrors[routine.id] || routine.lastError) return { kind: 'error', label: 'Error' }
  if (routine.runningActivityIds.length) return { kind: 'running', label: 'Running' }
  if (!routine.available) return { kind: 'unavailable', label: 'Unavailable' }
  if (!routine.enabled) return { kind: 'paused', label: 'Paused' }
  return { kind: 'ready', label: 'Armed' }
}

function nextFireLabel(routine) {
  if (!routine.enabled) return 'Paused'
  if (!routine.available) return 'Unavailable'
  if (!routine.nextFire) return 'Calculating'
  const timestamp = Date.parse(routine.nextFire)
  if (!Number.isFinite(timestamp)) return 'Unknown'
  const deltaMinutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000))
  if (deltaMinutes < 1) return 'now'
  if (deltaMinutes < 60) return `in ${deltaMinutes}m`
  if (deltaMinutes < 24 * 60) {
    const hours = Math.floor(deltaMinutes / 60)
    const minutes = deltaMinutes % 60
    return `in ${hours}h${minutes ? ` ${minutes}m` : ''}`
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function exactTime(value) {
  const timestamp = Date.parse(value || '')
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function policyLabel(value) {
  return String(value || '')
    .split('-')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join(' ')
}

function runTitle(routine) {
  if (!routine.available) return routine.diagnostic || `Preset '${routine.preset}' is unavailable`
  return `Run ${routine.title} now`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown routine failure')
}
</script>

<style scoped>
.routines-surface {
  container-type: inline-size;
}

.routine-detail-grid {
  grid-template-columns: minmax(0, 1.3fr) minmax(180px, 0.7fr);
}

@container (max-width: 500px) {
  .routine-row-main {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0.5rem;
  }

  .routine-row-main > :last-child {
    justify-content: space-between;
    padding-left: 1rem;
  }

  .routine-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
