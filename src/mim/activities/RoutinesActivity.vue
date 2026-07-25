<template>
  <section
    data-routines-activity
    class="routines-surface flex h-full min-h-0 flex-col bg-chrome-high text-ink"
    @keydown="onSurfaceKeydown"
  >
    <header class="flex min-h-11 shrink-0 items-center gap-2 border-b border-rule px-3">
      <div class="grid size-7 shrink-0 place-items-center border border-rule bg-surface text-ink-2">
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
        <p class="truncate font-mono text-[8px] tracking-[0.03em] text-ink-3" :title="routines.directory">
          {{ routines.directory || '~/.mim/routines' }}
        </p>
      </div>
      <button
        type="button"
        data-routines-new
        title="New routine (⌘N)"
        class="flex h-7 items-center gap-1.5 border border-rule bg-surface px-2 text-[9px] font-semibold hover:border-accent/50 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="openCreate"
      >
        <IconPlus :size="12" :stroke-width="1.9" />
        New
      </button>
      <button
        type="button"
        data-routines-reveal
        title="Reveal routine definitions folder"
        aria-label="Reveal routine definitions folder"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="revealDirectory"
      >
        <IconFolderOpen :size="13" :stroke-width="1.7" />
      </button>
      <button
        type="button"
        data-routines-reload
        title="Reload routine definitions (⌘R)"
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
        <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">Reading schedules</p>
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

    <div
      v-else
      class="min-h-0 flex-1 overflow-y-auto"
      @contextmenu.prevent.self="openSurfaceMenu"
    >
      <div
        v-if="routines.routines.length"
        ref="listRef"
        data-routine-list
        role="listbox"
        aria-label="Routines"
        :aria-activedescendant="routines.selectedRoutine ? `routine-${routines.selectedRoutine.id}` : undefined"
        tabindex="0"
        class="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        @keydown.down.prevent="moveSelection(1)"
        @keydown.up.prevent="moveSelection(-1)"
        @keydown.home.prevent="selectEdge('start')"
        @keydown.end.prevent="selectEdge('end')"
        @keydown.enter.prevent="runSelected"
        @contextmenu.prevent.self="openSurfaceMenu"
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
          @contextmenu.prevent.stop="openRowMenu($event, routine)"
        >
          <div class="routine-row-main grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2">
            <button
              type="button"
              :data-routine-select="routine.id"
              class="grid min-w-0 grid-cols-[8px_minmax(0,1fr)] items-start gap-2 text-left focus-visible:outline-none"
              @click="routines.select(routine.id)"
              @dblclick="openDefinition(routine)"
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

            <div class="flex items-center gap-1.5">
              <div class="mr-2 hidden min-w-24 text-right @[500px]:block">
                <p class="font-mono text-[9px] tabular-nums text-ink-2" :title="exactTime(routine.nextFire)">
                  {{ nextFireLabel(routine) }}
                </p>
                <p class="mt-0.5 text-[8px] text-ink-3">next fire</p>
              </div>
              <button
                v-if="routine.runningActivityIds.length"
                type="button"
                :data-routine-stop="routine.id"
                :aria-label="`Stop live runs for ${routine.title}`"
                :disabled="Boolean(routines.pendingStops[routine.id])"
                class="grid size-7 place-items-center border border-accent/35 bg-accent-soft text-accent hover:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                @click="stop(routine)"
              >
                <IconPlayerStop :size="11" :stroke-width="1.9" />
              </button>
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
              <button
                type="button"
                :data-routine-menu="routine.id"
                :aria-label="`Actions for ${routine.title}`"
                aria-haspopup="menu"
                class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="openButtonMenu($event, routine)"
              >
                <IconDots :size="14" :stroke-width="1.8" />
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
              <p class="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-ink-2">{{ routine.prompt }}</p>
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
              <dt class="text-ink-3">Source</dt>
              <dd class="truncate font-mono text-ink-2" :title="routine.path">{{ fileName(routine.path) }}</dd>
            </dl>

            <div class="col-span-full flex flex-wrap items-center gap-2">
              <button
                type="button"
                :data-routine-edit="routine.id"
                class="h-7 border border-rule bg-surface px-2.5 text-[9px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="openEdit(routine)"
              >
                Edit routine
              </button>
              <button
                type="button"
                :data-routine-open-source="routine.id"
                class="h-7 border border-rule bg-surface px-2.5 text-[9px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="openDefinition(routine)"
              >
                Open TOML
              </button>
            </div>

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
        @contextmenu.prevent="openSurfaceMenu"
      >
        <div class="max-w-md">
          <IconCalendarPlus :size="22" :stroke-width="1.45" class="mx-auto text-ink-3" />
          <p class="mt-3 text-[12px] font-semibold">{{ routines.diagnostics.length ? 'No valid routines' : 'No routines yet' }}</p>
          <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
            Routine definitions are ordinary <span class="font-mono">.toml</span> files in
            <span class="font-mono text-ink-2">{{ routines.directory || '~/.mim/routines' }}</span>.
            Create one here or edit the files directly; each run becomes a normal agent Activity.
          </p>
          <div class="mt-4 flex justify-center gap-2">
            <button
              type="button"
              data-routines-empty-create
              class="h-8 bg-accent px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="openCreate"
            >
              Create routine
            </button>
            <button
              type="button"
              class="h-8 border border-rule px-3 text-[10px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="revealDirectory"
            >
              Open folder
            </button>
          </div>
        </div>
      </div>

      <details
        v-if="routines.diagnostics.length"
        data-routine-diagnostics
        :open="!routines.routines.length"
        class="mx-3 my-3 border border-rem/25 bg-rem/5"
      >
        <summary class="cursor-pointer px-3 py-2 font-mono text-[9px] uppercase tracking-[0.1em] text-rem">
          {{ routines.diagnostics.length }} definition {{ routines.diagnostics.length === 1 ? 'problem' : 'problems' }}
        </summary>
        <div class="border-t border-rem/20">
          <button
            v-for="diagnostic in routines.diagnostics"
            :key="`${diagnostic.path}:${diagnostic.field}:${diagnostic.message}`"
            type="button"
            class="block w-full border-b border-rem/15 px-3 py-2 text-left last:border-b-0 hover:bg-rem/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rem"
            title="Open definition"
            @click="openPath(diagnostic.path)"
          >
            <p class="break-all font-mono text-[8px] text-rem/80">
              {{ diagnostic.path }}{{ diagnostic.field ? ` · ${diagnostic.field}` : '' }}
            </p>
            <p class="mt-1 text-[10px] leading-relaxed text-ink-2">{{ diagnostic.message }}</p>
          </button>
        </div>
      </details>
    </div>

    <footer v-if="routines.loaded" class="flex min-h-9 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3">
      <p class="min-w-0 flex-1 truncate font-mono text-[8px] text-ink-3" :title="routines.statePath">
        {{ footerText }}
      </p>
      <p v-if="notice" data-routine-notice class="shrink-0 text-[9px] text-accent">{{ notice }}</p>
      <p v-else class="shrink-0 font-mono text-[8px] tabular-nums text-ink-3">rev {{ routines.revision }}</p>
    </footer>

    <div
      v-if="routines.error && routines.loaded && !dialogMode"
      data-routines-inline-error
      role="alert"
      class="shrink-0 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      {{ routines.error }}
    </div>

    <div
      v-if="contextOpen"
      class="fixed inset-0 z-[260]"
      @pointerdown.self="closeContextMenu"
      @contextmenu.prevent.self="closeContextMenu"
    >
      <div
        ref="contextMenuRef"
        data-routines-context-menu
        role="menu"
        tabindex="-1"
        class="fixed min-w-52 border border-rule bg-surface py-1 text-[11px] text-ink-2"
        :style="contextStyle"
        @pointerdown.stop
        @keydown="onContextMenuKeydown"
      >
        <template v-if="contextRoutine">
          <ContextAction label="Run now" action="run" shortcut="↩" :disabled="!contextRoutine.available" @select="runContext" />
          <ContextAction
            v-if="contextRoutine.runningActivityIds.length"
            label="Stop live runs"
            action="stop"
            shortcut="⌘."
            @select="stopContext"
          />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Edit / rename…" action="edit" shortcut="F2" @select="editContext" />
          <ContextAction label="Open TOML" action="open-source" shortcut="⌘O" @select="openContextSource" />
          <ContextAction label="Duplicate…" action="duplicate" @select="duplicateContext" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Reveal definition" action="reveal" @select="revealContext" />
          <ContextAction label="Copy path" action="copy-path" @select="copyContextPath" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Move to Trash…" action="trash" shortcut="⌘⌫" danger @select="trashContext" />
        </template>
        <template v-else>
          <ContextAction label="New routine…" action="new" shortcut="⌘N" @select="createContext" />
          <ContextAction label="Reveal definitions folder" action="reveal-directory" @select="revealDirectoryContext" />
          <ContextAction label="Reload definitions" action="reload" shortcut="⌘R" @select="reloadContext" />
        </template>
      </div>
    </div>

    <div
      v-if="dialogMode"
      class="fixed inset-0 z-[270] grid place-items-center bg-black/25 px-4 py-6"
      @pointerdown.self="closeDialog"
    >
      <section
        role="dialog"
        aria-modal="true"
        :aria-labelledby="dialogHeadingId"
        class="flex max-h-full w-full max-w-xl flex-col border border-rule bg-surface"
      >
        <header class="flex h-10 shrink-0 items-center border-b border-rule bg-chrome-high px-4">
          <h2 :id="dialogHeadingId" class="text-[12px] font-semibold">{{ dialogTitle }}</h2>
        </header>
        <form data-routine-form class="min-h-0 overflow-y-auto p-4" @submit.prevent="submitDialog">
          <template v-if="dialogMode === 'duplicate'">
            <p class="mb-4 border-l border-accent bg-accent-soft px-3 py-2 text-[10px] leading-relaxed text-ink-2">
              The copy keeps the schedule, prompt, launcher, and policies, but starts paused so it cannot double-fire unexpectedly.
            </p>
            <div class="grid gap-3 sm:grid-cols-2">
              <RoutineField label="New id" required>
                <input
                  ref="dialogInputRef"
                  v-model="draft.id"
                  data-routine-id-input
                  class="routine-input font-mono"
                  autocomplete="off"
                  spellcheck="false"
                />
              </RoutineField>
              <RoutineField label="Title" required>
                <input v-model="draft.title" data-routine-title-input class="routine-input" autocomplete="off" />
              </RoutineField>
            </div>
          </template>
          <template v-else>
            <div class="grid gap-3 sm:grid-cols-2">
              <RoutineField label="Id" required hint="Filename-safe; fixed after creation">
                <input
                  ref="dialogInputRef"
                  v-model="draft.id"
                  data-routine-id-input
                  class="routine-input font-mono disabled:bg-chrome disabled:text-ink-3"
                  :disabled="dialogMode === 'edit'"
                  autocomplete="off"
                  spellcheck="false"
                  @input="markIdManual"
                />
              </RoutineField>
              <RoutineField label="Title" required>
                <input
                  ref="titleInputRef"
                  v-model="draft.title"
                  data-routine-title-input
                  class="routine-input"
                  autocomplete="off"
                  @input="syncCreateId"
                />
              </RoutineField>
              <RoutineField label="Schedule" required hint="5-field or 6/7-field cron">
                <input v-model="draft.schedule" data-routine-schedule-input class="routine-input font-mono" autocomplete="off" spellcheck="false" />
              </RoutineField>
              <RoutineField label="Timezone" required>
                <input v-model="draft.timezone" data-routine-timezone-input class="routine-input font-mono" list="routine-timezones" autocomplete="off" spellcheck="false" />
              </RoutineField>
              <RoutineField label="Launcher preset" required hint="Configured in Settings → Launchers">
                <input v-model="draft.preset" data-routine-preset-input class="routine-input font-mono" list="routine-presets" autocomplete="off" spellcheck="false" />
              </RoutineField>
              <RoutineField label="Workspace" hint="Empty uses the launcher default">
                <input v-model="draft.workspace" data-routine-workspace-input class="routine-input font-mono" autocomplete="off" spellcheck="false" />
              </RoutineField>
              <RoutineField label="Overlap">
                <select v-model="draft.overlap" data-routine-overlap-input class="routine-input">
                  <option value="skip">Skip while a previous run is active</option>
                  <option value="parallel">Allow parallel runs</option>
                </select>
              </RoutineField>
              <RoutineField label="Missed fire">
                <select v-model="draft.missed" data-routine-missed-input class="routine-input">
                  <option value="run-once">Run once after wake</option>
                  <option value="skip">Skip missed runs</option>
                </select>
              </RoutineField>
            </div>
            <RoutineField label="Agent prompt" required class="mt-3">
              <textarea
                v-model="draft.prompt"
                data-routine-prompt-input
                rows="5"
                class="w-full resize-y border border-rule bg-surface px-2 py-2 text-[11px] leading-relaxed outline-none focus:border-accent"
              />
            </RoutineField>
            <label class="mt-3 flex min-h-8 cursor-pointer items-center gap-2 border border-rule px-3 text-[10px]">
              <input v-model="draft.enabled" data-routine-enabled-input type="checkbox" class="accent-[var(--color-accent)]" />
              <span>
                <strong class="font-semibold">Armed</strong>
                <span class="ml-1 text-ink-3">— allow automatic scheduled fires</span>
              </span>
            </label>
          </template>

          <datalist id="routine-timezones">
            <option value="Europe/Berlin" />
            <option value="UTC" />
            <option value="America/New_York" />
            <option value="Asia/Tokyo" />
          </datalist>
          <datalist id="routine-presets">
            <option v-for="preset in presetSuggestions" :key="preset" :value="preset" />
          </datalist>

          <p v-if="formError" data-routine-form-error class="mt-3 border-l border-rem bg-rem/5 px-3 py-2 text-[10px] text-rem" role="alert">
            {{ formError }}
          </p>
          <p v-else-if="dialogMode === 'edit'" class="mt-3 truncate font-mono text-[8px] text-ink-4" :title="dialogTarget?.path">
            {{ dialogTarget?.path }}
          </p>

          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="closeDialog"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-routine-form-submit
              :disabled="dialogBusy"
              class="h-7 bg-accent px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            >
              {{ dialogBusy ? 'Saving…' : dialogSubmitLabel }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <div
      v-if="trashTarget"
      data-routine-trash-dialog
      class="fixed inset-0 z-[270] grid place-items-center bg-black/25 px-4"
      @pointerdown.self="closeTrashDialog"
    >
      <section role="alertdialog" aria-modal="true" aria-label="Move routine to Trash" class="w-full max-w-sm border border-rule bg-surface">
        <header class="flex h-10 items-center border-b border-rule bg-chrome-high px-4">
          <h2 class="text-[12px] font-semibold">Move {{ trashTarget.title }} to Trash?</h2>
        </header>
        <div class="space-y-3 p-4">
          <p class="text-[11px] leading-relaxed text-ink-2">
            Its TOML definition moves to the system Trash and can be restored there. Any live run remains in the Activity tray until you stop or close it.
          </p>
          <p v-if="trashError" class="text-[10px] leading-relaxed text-rem">{{ trashError }}</p>
          <div class="flex justify-end gap-2">
            <button type="button" class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome" @click="closeTrashDialog">Cancel</button>
            <button
              type="button"
              data-routine-confirm-trash
              :disabled="trashBusy"
              class="h-7 bg-rem px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              @click="confirmTrash"
            >
              {{ trashBusy ? 'Moving…' : 'Move to Trash' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onMounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconCalendarClock,
  IconCalendarPlus,
  IconDots,
  IconFolderOpen,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
} from '@tabler/icons-vue'
import { useRoutinesStore } from '../../stores/routines.js'

const ContextAction = defineComponent({
  props: {
    label: { type: String, required: true },
    action: { type: String, required: true },
    shortcut: { type: String, default: '' },
    danger: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: ['select'],
  setup(props, { emit }) {
    return () => h('button', {
      type: 'button',
      role: 'menuitem',
      disabled: props.disabled,
      'data-routine-action': props.action,
      class: [
        'flex h-7 w-full items-center gap-4 px-3 text-left hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-35',
        props.danger ? 'text-rem' : 'text-ink-2',
      ],
      onClick: () => emit('select'),
    }, [
      h('span', { class: 'min-w-0 flex-1 truncate' }, props.label),
      props.shortcut ? h('span', { class: 'font-mono text-[8px] text-ink-4' }, props.shortcut) : null,
    ])
  },
})

const RoutineField = defineComponent({
  props: {
    label: { type: String, required: true },
    hint: { type: String, default: '' },
    required: { type: Boolean, default: false },
  },
  setup(props, { slots, attrs }) {
    return () => h('label', { class: ['block', attrs.class] }, [
      h('span', { class: 'mb-1.5 flex items-baseline gap-1 text-[10px] text-ink-3' }, [
        h('span', props.label),
        props.required ? h('span', { class: 'text-rem', 'aria-hidden': 'true' }, '•') : null,
        props.hint ? h('span', { class: 'ml-auto text-[8px] text-ink-4' }, props.hint) : null,
      ]),
      slots.default?.(),
    ])
  },
})

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['diagnostic', 'openFile', 'openActivity'])
const routines = useRoutinesStore()
const notice = ref('')
const listRef = ref(null)
const contextMenuRef = ref(null)
const contextRoutine = ref(null)
const contextOpen = ref(false)
const contextPosition = ref({ x: 12, y: 12 })
const dialogMode = ref('')
const dialogTarget = ref(null)
const dialogInputRef = ref(null)
const titleInputRef = ref(null)
const dialogBusy = ref(false)
const formError = ref('')
const draft = ref(emptyDraft())
const createIdWasGenerated = ref(true)
const trashTarget = ref(null)
const trashError = ref('')
const trashBusy = ref(false)

const dialogHeadingId = 'routine-dialog-title'
const footerText = computed(() => (
  routines.statePath ? `planner · ${routines.statePath}` : 'Local scheduler · definitions stay on disk'
))
const contextStyle = computed(() => ({
  left: `${contextPosition.value.x}px`,
  top: `${contextPosition.value.y}px`,
}))
const dialogTitle = computed(() => ({
  create: 'New routine',
  edit: `Edit ${dialogTarget.value?.title || 'routine'}`,
  duplicate: `Duplicate ${dialogTarget.value?.title || 'routine'}`,
}[dialogMode.value] || 'Routine'))
const dialogSubmitLabel = computed(() => ({
  create: 'Create routine',
  edit: 'Save routine',
  duplicate: 'Create paused copy',
}[dialogMode.value] || 'Save'))
const presetSuggestions = computed(() => [...new Set([
  ...routines.routines.map((routine) => routine.preset).filter(Boolean),
  'codex',
  'claude',
  'pi',
])])

onMounted(() => initialize())
watch(() => props.active, (active, wasActive) => {
  if (!active || wasActive !== false) return
  if (routines.loaded) void activationReload()
  else void initialize()
})

async function initialize() {
  try {
    await routines.initialize()
  } catch (error) {
    emit('diagnostic', errorMessage(error))
  }
}

async function activationReload() {
  try {
    await routines.reload()
  } catch (error) {
    emit('diagnostic', `Routines could not refresh: ${errorMessage(error)}`)
  }
}

async function reload() {
  closeContextMenu()
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
  closeContextMenu()
  notice.value = ''
  try {
    const result = await routines.runNow(routine.id)
    if (result) {
      notice.value = `${routine.title} started`
      if (result.activity?.id) emit('openActivity', result.activity)
    }
  } catch (error) {
    emit('diagnostic', `${routine.title} did not start: ${errorMessage(error)}`)
  }
}

async function stop(routine) {
  if (!routine?.runningActivityIds.length || routines.pendingStops[routine.id]) return
  routines.select(routine.id)
  closeContextMenu()
  notice.value = ''
  try {
    const count = await routines.stopRuns(routine.id)
    if (count) notice.value = `${count} ${count === 1 ? 'run' : 'runs'} stopped`
  } catch (error) {
    emit('diagnostic', `${routine.title} could not stop: ${errorMessage(error)}`)
  }
}

function openCreate() {
  closeContextMenu()
  dialogTarget.value = null
  dialogMode.value = 'create'
  draft.value = emptyDraft()
  createIdWasGenerated.value = true
  formError.value = ''
  nextTick(() => titleInputRef.value?.focus())
}

function openEdit(routine = routines.selectedRoutine) {
  if (!routine) return
  closeContextMenu()
  routines.select(routine.id)
  dialogTarget.value = routine
  dialogMode.value = 'edit'
  draft.value = definitionDraft(routine)
  formError.value = ''
  nextTick(() => titleInputRef.value?.focus())
}

function openDuplicate(routine = routines.selectedRoutine) {
  if (!routine) return
  closeContextMenu()
  routines.select(routine.id)
  dialogTarget.value = routine
  dialogMode.value = 'duplicate'
  draft.value = {
    ...definitionDraft(routine),
    id: uniqueCopyId(routine.id),
    title: `${routine.title} copy`,
    enabled: false,
  }
  formError.value = ''
  nextTick(() => {
    dialogInputRef.value?.focus()
    dialogInputRef.value?.select()
  })
}

function closeDialog() {
  if (dialogBusy.value) return
  dialogMode.value = ''
  dialogTarget.value = null
  formError.value = ''
  nextTick(() => listRef.value?.focus())
}

async function submitDialog() {
  formError.value = validateDraft(draft.value, dialogMode.value)
  if (formError.value) return
  dialogBusy.value = true
  try {
    if (dialogMode.value === 'create') {
      await routines.create(draft.value)
      notice.value = `${draft.value.title} created`
    } else if (dialogMode.value === 'edit') {
      await routines.update(dialogTarget.value.id, draft.value)
      notice.value = `${draft.value.title} saved`
    } else {
      await routines.duplicate(
        dialogTarget.value.id,
        draft.value.id,
        draft.value.title,
      )
      notice.value = `${draft.value.title} created paused`
    }
    dialogMode.value = ''
    dialogTarget.value = null
    nextTick(() => listRef.value?.focus())
  } catch (error) {
    formError.value = errorMessage(error)
    emit('diagnostic', `Routine could not save: ${formError.value}`)
  } finally {
    dialogBusy.value = false
  }
}

function syncCreateId() {
  if (dialogMode.value !== 'create') return
  if (!draft.value.id || createIdWasGenerated.value) {
    draft.value.id = slug(draft.value.title)
    createIdWasGenerated.value = true
  }
}

function markIdManual() {
  if (dialogMode.value === 'create') createIdWasGenerated.value = false
}

function promptTrash(routine = routines.selectedRoutine) {
  if (!routine) return
  closeContextMenu()
  routines.select(routine.id)
  trashTarget.value = routine
  trashError.value = ''
}

function closeTrashDialog() {
  if (trashBusy.value) return
  trashTarget.value = null
  trashError.value = ''
}

async function confirmTrash() {
  if (!trashTarget.value || trashBusy.value) return
  trashBusy.value = true
  const target = trashTarget.value
  try {
    await routines.trash(target.id)
    notice.value = `${target.title} moved to Trash`
    trashTarget.value = null
    nextTick(() => listRef.value?.focus())
  } catch (error) {
    trashError.value = errorMessage(error)
    emit('diagnostic', `${target.title} could not move to Trash: ${trashError.value}`)
  } finally {
    trashBusy.value = false
  }
}

function openDefinition(routine = routines.selectedRoutine) {
  if (!routine?.path) return
  routines.select(routine.id)
  closeContextMenu()
  openPath(routine.path)
}

function openPath(path) {
  if (path) emit('openFile', path)
}

async function revealDirectory() {
  closeContextMenu()
  try {
    await routines.reveal()
    notice.value = 'Definitions folder revealed'
  } catch (error) {
    emit('diagnostic', `Definitions folder could not open: ${errorMessage(error)}`)
  }
}

async function revealRoutine(routine = routines.selectedRoutine) {
  if (!routine) return
  closeContextMenu()
  try {
    await routines.reveal(routine.id)
    notice.value = `${routine.title} revealed`
  } catch (error) {
    emit('diagnostic', `${routine.title} could not be revealed: ${errorMessage(error)}`)
  }
}

async function copyPath(routine = routines.selectedRoutine) {
  if (!routine?.path) return
  closeContextMenu()
  try {
    await navigator.clipboard.writeText(routine.path)
    notice.value = 'Definition path copied'
  } catch (error) {
    emit('diagnostic', `Path could not be copied: ${errorMessage(error)}`)
  }
}

function openRowMenu(event, routine) {
  routines.select(routine.id)
  openContextMenu(event.clientX, event.clientY, routine)
}

function openButtonMenu(event, routine) {
  const rect = event.currentTarget.getBoundingClientRect()
  routines.select(routine.id)
  openContextMenu(rect.right, rect.bottom + 4, routine)
}

function openSurfaceMenu(event) {
  openContextMenu(event.clientX, event.clientY, null)
}

function openContextMenu(x, y, routine) {
  dialogMode.value = ''
  contextRoutine.value = routine
  contextPosition.value = {
    x: Math.max(8, Math.min(x, window.innerWidth - 224)),
    y: Math.max(8, Math.min(y, window.innerHeight - 260)),
  }
  contextOpen.value = true
  nextTick(() => {
    contextMenuRef.value?.focus()
    menuItems()[0]?.focus()
  })
}

function closeContextMenu() {
  contextOpen.value = false
  contextRoutine.value = null
}

function menuItems() {
  return [...(contextMenuRef.value?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
}

function onContextMenuKeydown(event) {
  const items = menuItems()
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement))
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    items[(current + delta + items.length) % items.length].focus()
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    items[event.key === 'End' ? items.length - 1 : 0].focus()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeContextMenu()
    nextTick(() => listRef.value?.focus())
  }
}

function onSurfaceKeydown(event) {
  if (dialogMode.value || trashTarget.value || contextOpen.value) {
    if (event.key === 'Escape') {
      if (contextOpen.value) closeContextMenu()
      else if (trashTarget.value) closeTrashDialog()
      else closeDialog()
    }
    return
  }
  if (isTextInput(event.target)) return
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  let handled = true
  if (command && key === 'n') openCreate()
  else if (command && key === 'r') void reload()
  else if (command && key === 'o') openDefinition()
  else if (command && key === '.') void stop(routines.selectedRoutine)
  else if ((command && key === 'backspace') || event.key === 'Delete') promptTrash()
  else if (event.key === 'F2') openEdit()
  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const selected = routines.selectedRoutine
    const row = selected ? document.getElementById(`routine-${selected.id}`) : null
    const rect = row?.getBoundingClientRect()
    openContextMenu(rect?.left || 16, rect?.top || 48, selected)
  } else handled = false
  if (handled) {
    event.preventDefault()
    event.stopPropagation()
  }
}

function runContext() { void run(contextRoutine.value) }
function stopContext() { void stop(contextRoutine.value) }
function editContext() { openEdit(contextRoutine.value) }
function openContextSource() { openDefinition(contextRoutine.value) }
function duplicateContext() { openDuplicate(contextRoutine.value) }
function revealContext() { void revealRoutine(contextRoutine.value) }
function copyContextPath() { void copyPath(contextRoutine.value) }
function trashContext() { promptTrash(contextRoutine.value) }
function createContext() { openCreate() }
function revealDirectoryContext() { void revealDirectory() }
function reloadContext() { void reload() }

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

function emptyDraft() {
  return {
    id: '',
    title: '',
    enabled: true,
    schedule: '0 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    preset: 'codex',
    prompt: '',
    overlap: 'skip',
    missed: 'run-once',
    workspace: '',
  }
}

function definitionDraft(routine) {
  return {
    id: routine.id,
    title: routine.title,
    enabled: routine.enabled,
    schedule: routine.schedule,
    timezone: routine.timezone,
    preset: routine.preset,
    prompt: routine.prompt,
    overlap: routine.overlap,
    missed: routine.missed,
    workspace: routine.workspace || '',
  }
}

function validateDraft(value, mode) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.id || '')) {
    return 'Id must be 1–64 letters, numbers, hyphens, or underscores.'
  }
  if (mode === 'duplicate' && value.id === dialogTarget.value?.id) {
    return 'Give the copy a new id.'
  }
  if (!value.title?.trim()) return 'Title is required.'
  if (mode === 'duplicate') return ''
  if (!value.schedule?.trim()) return 'Schedule is required.'
  if (!value.timezone?.trim()) return 'Timezone is required.'
  if (!value.preset?.trim()) return 'Launcher preset is required.'
  if (!value.prompt?.trim()) return 'Agent prompt is required.'
  return ''
}

function uniqueCopyId(id) {
  const base = `${id}-copy`.slice(0, 64)
  if (!routines.routines.some((routine) => routine.id === base)) return base
  let index = 2
  while (routines.routines.some((routine) => routine.id === `${base}-${index}`.slice(0, 64))) index += 1
  return `${base}-${index}`.slice(0, 64)
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'definition.toml'
}

function isTextInput(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
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

.routine-input {
  height: 2rem;
  width: 100%;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 0.5rem;
  font-size: 11px;
  outline: none;
}

.routine-input:focus {
  border-color: var(--color-accent);
}

@container (max-width: 540px) {
  .routine-row-main {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0.5rem;
  }

  .routine-row-main > :last-child {
    justify-content: flex-end;
    padding-left: 1rem;
  }

  .routine-detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
