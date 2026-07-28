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
          <p class="text-[11px] font-semibold">Routines</p>
          <p
            v-if="routines.loaded"
            data-routines-summary
            class="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-3"
          >
            {{ summaryText }}
          </p>
        </div>
        <p class="truncate font-mono text-[8px] tracking-[0.03em] text-ink-3" :title="routines.directory">
          {{ routines.directory || '~/.mimir/routines' }}
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
                  <span class="truncate">{{ scheduleLabel(routine) }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="truncate">{{ routine.preset }}</span>
                  <template v-if="foreignTimezone(routine)">
                    <span aria-hidden="true">·</span>
                    <span class="shrink-0 font-mono">{{ routine.timezone }}</span>
                  </template>
                </span>
              </span>
            </button>

            <div class="flex items-center gap-1.5">
              <div class="mr-2 hidden min-w-24 text-right @[500px]:block">
                <p class="font-mono text-[9px] tabular-nums text-ink-2" :title="exactTime(routine.nextFire)">
                  {{ nextFireLabel(routine) }}
                </p>
                <p class="mt-0.5 text-[8px] text-ink-3">{{ routine.schedule ? 'next fire' : 'on demand' }}</p>
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
              <dt class="text-ink-3">Schedule</dt>
              <dd class="truncate font-mono text-ink-2" :title="routine.schedule || undefined">
                {{ routine.schedule || 'Manual — runs on demand' }}
              </dd>
              <template v-if="foreignTimezone(routine)">
                <dt class="text-ink-3">Timezone</dt>
                <dd class="truncate font-mono text-ink-2">{{ routine.timezone }}</dd>
              </template>
              <dt class="text-ink-3">Session</dt>
              <dd class="text-ink-2">{{ routine.interactive ? 'Interactive' : 'One-shot' }}</dd>
              <dt class="text-ink-3">Workspace</dt>
              <dd class="truncate font-mono text-ink-2" :title="routine.workspace || 'Launcher default'">
                {{ routine.workspace || 'Launcher default' }}
              </dd>
              <dt class="text-ink-3">Overlap</dt>
              <dd class="text-ink-2">{{ policyLabel(routine.overlap) }}</dd>
              <template v-if="routine.schedule">
                <dt class="text-ink-3">Missed</dt>
                <dd class="text-ink-2">{{ policyLabel(routine.missed) }}</dd>
              </template>
              <dt class="text-ink-3">Next</dt>
              <dd class="font-mono text-ink-2">
                {{ exactTime(routine.nextFire) || (routine.schedule ? 'Not scheduled' : 'On demand') }}
              </dd>
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
            A routine hands a saved prompt to a coding agent — on a schedule, or on demand
            with one click. Definitions are ordinary <span class="font-mono">.toml</span> files in
            <span class="font-mono text-ink-2">{{ routines.directory || '~/.mimir/routines' }}</span>,
            and each run becomes a normal agent Activity.
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
        <form data-routine-form class="min-h-0 space-y-4 overflow-y-auto p-4" @submit.prevent="submitDialog">
          <template v-if="dialogMode === 'duplicate'">
            <p class="border-l border-accent bg-accent-soft px-3 py-2 text-[10px] leading-relaxed text-ink-2">
              The copy keeps the prompt, agent, schedule, and policies. Scheduled copies start
              paused so they cannot double-fire.
            </p>
            <RoutineField label="Title" required>
              <input
                ref="titleInputRef"
                v-model="draft.title"
                data-routine-title-input
                class="routine-input"
                autocomplete="off"
              />
            </RoutineField>
          </template>
          <template v-else>
            <RoutineField label="Title" required>
              <input
                ref="titleInputRef"
                v-model="draft.title"
                data-routine-title-input
                class="routine-input"
                autocomplete="off"
                placeholder="Morning review"
              />
            </RoutineField>

            <RoutineField label="Agent" required tag="div">
              <p v-if="launchers.loading || !launchers.ready" class="text-[10px] text-ink-3">
                Detecting installed agents…
              </p>
              <div
                v-else-if="agentChoices.length"
                role="radiogroup"
                aria-label="Agent"
                class="grid grid-cols-2 gap-1.5"
              >
                <button
                  v-for="choice in agentChoices"
                  :key="choice.id"
                  type="button"
                  role="radio"
                  :aria-checked="draft.preset === choice.id"
                  :data-routine-preset-option="choice.id"
                  :title="choice.available ? choice.title : choice.unavailableReason"
                  class="flex h-8 min-w-0 items-center gap-2 border px-2.5 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  :class="draft.preset === choice.id
                    ? 'border-accent bg-accent-soft font-semibold text-ink'
                    : choice.available
                      ? 'border-rule bg-surface text-ink-2 hover:border-accent/40'
                      : 'border-dashed border-rule bg-surface text-ink-3'"
                  @click="draft.preset = choice.id"
                >
                  <span
                    class="block size-1.5 shrink-0"
                    :class="choice.available ? 'bg-accent' : 'border border-ink-3'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate text-left">{{ choice.title }}</span>
                  <span v-if="!choice.available" class="shrink-0 font-mono text-[7px] uppercase tracking-[0.1em]">
                    not found
                  </span>
                </button>
              </div>
              <p v-else data-routine-no-agents class="border-l border-rem bg-rem/5 px-3 py-2 text-[10px] text-ink-2">
                No coding agents are configured. Enable one under Settings → Coding agents first.
              </p>
            </RoutineField>

            <RoutineField
              v-if="workspaceVisible"
              label="Workspace"
              :required="workspaceRequired"
              :hint="workspaceRequired
                ? `${selectedAgent?.title || 'This launcher'} runs in this folder`
                : 'Used when the launcher runs in a workspace'"
            >
              <input
                v-model="draft.workspace"
                data-routine-workspace-input
                class="routine-input font-mono"
                autocomplete="off"
                spellcheck="false"
                placeholder="/path/to/project"
                @input="workspaceWasPrefilled = false"
              />
            </RoutineField>

            <RoutineField label="Prompt" required>
              <textarea
                v-model="draft.prompt"
                data-routine-prompt-input
                rows="4"
                placeholder="What should the agent do on each run?"
                class="w-full resize-y border border-rule bg-surface px-2 py-2 text-[11px] leading-relaxed outline-none focus:border-accent"
              />
            </RoutineField>

            <RoutineField label="Session" tag="div">
              <div class="flex border border-rule" role="radiogroup" aria-label="Session">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="draft.interactive"
                  data-routine-session-interactive
                  class="h-7 flex-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  :class="draft.interactive ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                  @click="draft.interactive = true"
                >
                  Interactive
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-checked="!draft.interactive"
                  data-routine-session-one-shot
                  class="h-7 flex-1 border-l border-rule text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  :class="!draft.interactive ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                  @click="draft.interactive = false"
                >
                  One-shot
                </button>
              </div>
              <p class="mt-1.5 text-[9px] leading-relaxed text-ink-3">
                <template v-if="draft.interactive">
                  Opens the agent's live session with the prompt as your first message — follow up
                  right in the terminal.
                </template>
                <template v-else>
                  Runs the prompt headless: the agent works it through, reports, and exits.
                </template>
              </p>
              <p
                v-if="draft.interactive && draft.scheduled && draft.overlap === 'skip'"
                data-routine-session-note
                class="mt-1 border-l border-rule pl-2 text-[9px] leading-relaxed text-ink-3"
              >
                Interactive sessions stay open — the next scheduled fire is skipped until you close
                the previous one.
              </p>
            </RoutineField>

            <RoutineField label="Run" tag="div">
              <div class="flex border border-rule" role="radiogroup" aria-label="Trigger">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="!draft.scheduled"
                  data-routine-trigger-manual
                  class="h-7 flex-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  :class="!draft.scheduled ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                  @click="draft.scheduled = false"
                >
                  On demand
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-checked="draft.scheduled"
                  data-routine-trigger-scheduled
                  class="h-7 flex-1 border-l border-rule text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  :class="draft.scheduled ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                  @click="draft.scheduled = true"
                >
                  On a schedule
                </button>
              </div>

              <p v-if="!draft.scheduled" class="mt-1.5 text-[9px] leading-relaxed text-ink-3">
                Runs only when you press <span class="font-semibold text-ink-2">Run now</span> — in
                this list, with Enter on the row, or through MCP.
              </p>

              <div v-else class="mt-2 space-y-2 border border-rule-light bg-surface/55 p-2.5">
                <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Frequency">
                  <button
                    v-for="frequency in FREQUENCIES"
                    :key="frequency.id"
                    type="button"
                    role="radio"
                    :aria-checked="draft.scheduleState.frequency === frequency.id"
                    :data-routine-frequency="frequency.id"
                    class="h-6 border px-2 text-[9px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    :class="draft.scheduleState.frequency === frequency.id
                      ? 'border-accent bg-accent-soft font-semibold text-accent'
                      : 'border-rule bg-surface text-ink-3 hover:text-ink-2'"
                    @click="draft.scheduleState.frequency = frequency.id"
                  >
                    {{ frequency.label }}
                  </button>
                </div>

                <div
                  v-if="draft.scheduleState.frequency === 'weekly'"
                  class="flex gap-1"
                  role="group"
                  aria-label="Days of week"
                >
                  <button
                    v-for="day in WEEKDAYS"
                    :key="day.key"
                    type="button"
                    :aria-pressed="draft.scheduleState.days.includes(day.key)"
                    :aria-label="day.label"
                    :data-routine-day="day.key"
                    class="grid size-6 place-items-center border text-[9px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    :class="draft.scheduleState.days.includes(day.key)
                      ? 'border-accent bg-accent-soft font-semibold text-accent'
                      : 'border-rule bg-surface text-ink-3 hover:text-ink-2'"
                    @click="toggleDay(day.key)"
                  >
                    {{ day.short }}
                  </button>
                </div>

                <label
                  v-if="['daily', 'weekdays', 'weekly'].includes(draft.scheduleState.frequency)"
                  class="flex items-center gap-2 text-[10px] text-ink-3"
                >
                  at
                  <input
                    v-model="draft.scheduleState.time"
                    data-routine-time-input
                    type="time"
                    class="routine-input w-auto font-mono"
                  />
                </label>

                <label
                  v-else-if="draft.scheduleState.frequency === 'hourly'"
                  class="flex items-center gap-2 text-[10px] text-ink-3"
                >
                  at minute
                  <input
                    v-model.number="draft.scheduleState.minute"
                    data-routine-minute-input
                    type="number"
                    min="0"
                    max="59"
                    class="routine-input w-16 font-mono"
                  />
                </label>

                <div
                  v-else-if="draft.scheduleState.frequency === 'interval'"
                  class="flex items-center gap-1 text-[10px] text-ink-3"
                  role="radiogroup"
                  aria-label="Repeat interval"
                >
                  every
                  <button
                    v-for="choice in INTERVAL_CHOICES"
                    :key="choice"
                    type="button"
                    role="radio"
                    :aria-checked="draft.scheduleState.interval === choice"
                    :data-routine-interval="choice"
                    class="h-6 border px-2 font-mono text-[9px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    :class="draft.scheduleState.interval === choice
                      ? 'border-accent bg-accent-soft font-semibold text-accent'
                      : 'border-rule bg-surface text-ink-3 hover:text-ink-2'"
                    @click="draft.scheduleState.interval = choice"
                  >
                    {{ choice }}
                  </button>
                  minutes
                </div>

                <div v-else-if="draft.scheduleState.frequency === 'cron'">
                  <input
                    v-model="draft.scheduleState.cron"
                    data-routine-cron-input
                    class="routine-input font-mono"
                    placeholder="0 9 * * 1-5"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <p class="mt-1 text-[8px] text-ink-4">minute · hour · day · month · weekday — 6/7-field cron also works</p>
                </div>

                <p
                  data-routine-schedule-summary
                  class="border-t border-rule-light pt-2 text-[9px]"
                  :class="scheduleSummary.error ? 'text-rem' : 'text-ink-3'"
                >
                  {{ scheduleSummary.text }}
                </p>

                <label class="flex cursor-pointer items-center gap-2 text-[10px]">
                  <input v-model="draft.enabled" data-routine-enabled-input type="checkbox" class="accent-[var(--color-accent)]" />
                  <span>
                    <strong class="font-semibold">Armed</strong>
                    <span class="ml-1 text-ink-3">— fires automatically on this schedule</span>
                  </span>
                </label>
              </div>
            </RoutineField>

            <details data-routine-advanced class="border border-rule-light">
              <summary class="cursor-pointer px-3 py-2 text-[10px] text-ink-3 hover:text-ink-2">Advanced</summary>
              <div class="space-y-3 border-t border-rule-light p-3">
                <RoutineField label="If a run is still active" tag="div">
                  <div class="flex border border-rule" role="radiogroup" aria-label="Overlap policy">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="draft.overlap === 'skip'"
                      data-routine-overlap-skip
                      class="h-7 flex-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                      :class="draft.overlap === 'skip' ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                      @click="draft.overlap = 'skip'"
                    >
                      Skip the new run
                    </button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="draft.overlap === 'parallel'"
                      data-routine-overlap-parallel
                      class="h-7 flex-1 border-l border-rule text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                      :class="draft.overlap === 'parallel' ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                      @click="draft.overlap = 'parallel'"
                    >
                      Run in parallel
                    </button>
                  </div>
                </RoutineField>
                <RoutineField v-if="draft.scheduled" label="If a fire was missed while asleep" tag="div">
                  <div class="flex border border-rule" role="radiogroup" aria-label="Missed fire policy">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="draft.missed === 'run-once'"
                      data-routine-missed-run-once
                      class="h-7 flex-1 text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                      :class="draft.missed === 'run-once' ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                      @click="draft.missed = 'run-once'"
                    >
                      Run once after wake
                    </button>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="draft.missed === 'skip'"
                      data-routine-missed-skip
                      class="h-7 flex-1 border-l border-rule text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                      :class="draft.missed === 'skip' ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3 hover:bg-chrome'"
                      @click="draft.missed = 'skip'"
                    >
                      Skip it
                    </button>
                  </div>
                </RoutineField>
              </div>
            </details>
          </template>

          <p v-if="formError" data-routine-form-error class="border-l border-rem bg-rem/5 px-3 py-2 text-[10px] text-rem" role="alert">
            {{ formError }}
          </p>
          <p v-else-if="dialogMode === 'edit'" class="truncate font-mono text-[8px] text-ink-4" :title="dialogTarget?.path">
            {{ dialogTarget?.path }}
          </p>

          <div class="flex justify-end gap-2">
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
              :disabled="submitDisabled"
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
import { useLaunchersStore } from '../../stores/launchers.js'
import {
  FREQUENCIES,
  INTERVAL_CHOICES,
  WEEKDAYS,
  compileSchedule,
  defaultScheduleState,
  describeSchedule,
  describeScheduleState,
  parseSchedule,
} from './routineSchedule.js'

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
    // Button groups must not sit inside a <label>: label activation would
    // re-click the first button and undo the selection.
    tag: { type: String, default: 'label' },
  },
  setup(props, { slots, attrs }) {
    return () => h(props.tag, { class: ['block', attrs.class] }, [
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
const launchers = useLaunchersStore()
const notice = ref('')
const listRef = ref(null)
const contextMenuRef = ref(null)
const contextRoutine = ref(null)
const contextOpen = ref(false)
const contextPosition = ref({ x: 12, y: 12 })
const dialogMode = ref('')
const dialogTarget = ref(null)
const titleInputRef = ref(null)
const dialogBusy = ref(false)
const formError = ref('')
const draft = ref(emptyDraft())
const trashTarget = ref(null)
const trashError = ref('')
const trashBusy = ref(false)

const dialogHeadingId = 'routine-dialog-title'
const footerText = computed(() => (
  routines.statePath ? `planner · ${routines.statePath}` : 'Local scheduler · definitions stay on disk'
))
const summaryText = computed(() => {
  const parts = []
  if (routines.enabledCount) parts.push(`${routines.enabledCount} armed`)
  if (routines.manualCount) parts.push(`${routines.manualCount} manual`)
  if (routines.runningCount) parts.push(`${routines.runningCount} running`)
  return parts.join(' · ') || 'none armed'
})
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
  duplicate: 'Create copy',
}[dialogMode.value] || 'Save'))
// Saving before launcher detection resolves would validate against an empty
// preset catalog (no workspace requirement, no availability); hold the door.
const submitDisabled = computed(() => (
  dialogBusy.value || (dialogMode.value !== 'duplicate' && !launchers.ready)
))

// Every configured agent preset, decorated with detection state. The current
// draft preset is always offered — even when its preset vanished from the
// launcher config — so editing never silently drops a routine's agent.
const agentChoices = computed(() => {
  const choices = launchers.decoratedPresets
    .filter((preset) => preset.kind === 'agent')
    .map((preset) => ({
      id: preset.id,
      title: preset.title || preset.id,
      agentId: preset.agentId || '',
      available: preset.available && preset.enabled,
      // The routine's workspace only matters for presets whose working
      // directory is "the workspace" — home/custom presets ignore it.
      needsWorkspace: preset.cwd?.mode === 'workspace',
      unavailableReason: preset.unavailableReason
        || (preset.enabled ? '' : `${preset.title || preset.id} is disabled in Settings.`),
    }))
  const current = draft.value.preset
  if (current && !choices.some((choice) => choice.id === current)) {
    choices.push({
      id: current,
      title: current,
      agentId: '',
      available: false,
      needsWorkspace: false,
      unavailableReason: `Preset '${current}' is not configured under Settings → Coding agents.`,
    })
  }
  return choices
})
const selectedAgent = computed(() => (
  agentChoices.value.find((choice) => choice.id === draft.value.preset) || null
))
const workspaceRequired = computed(() => Boolean(selectedAgent.value?.needsWorkspace))
const workspaceVisible = computed(() => (
  workspaceRequired.value || Boolean(draft.value.workspace)
))
const scheduleSummary = computed(() => {
  const { cron, error } = compileSchedule(draft.value.scheduleState)
  if (error) return { text: error, error: true }
  const description = describeScheduleState(draft.value.scheduleState)
  const suffix = draft.value.scheduleState.frequency === 'cron' ? '' : ` — ${cron}`
  const zone = timezoneLabel(draft.value.timezone)
  return { text: `Runs ${description}${suffix} · ${zone}`, error: false }
})

onMounted(() => initialize())
watch(() => props.active, (active, wasActive) => {
  if (!active || wasActive !== false) return
  if (routines.loaded) void activationReload()
  else void initialize()
})
// Prefill visibly rather than fixing up at submit: the field is on screen,
// so the user sees — and can change — the folder the routine will run in.
// A prefill the user never touched is withdrawn again when they switch to an
// agent that ignores the workspace, so it cannot leak into the TOML.
const workspaceWasPrefilled = ref(false)
watch(workspaceRequired, (required) => {
  if (!required && workspaceWasPrefilled.value) {
    draft.value.workspace = ''
    workspaceWasPrefilled.value = false
    return
  }
  prefillWorkspace()
})

function prefillWorkspace() {
  if (!dialogMode.value || !workspaceRequired.value || draft.value.workspace) return
  const path = props.activity.workspacePath || ''
  if (!path) return
  draft.value.workspace = path
  workspaceWasPrefilled.value = true
}

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

// Workbench entry point: land keyboard focus on the routine listbox when the
// tool is opened from the Sidebar, so arrow keys work without a mouse click.
function focusEntry() {
  listRef.value?.focus()
}

defineExpose({ focusEntry })

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

function ensureLaunchers() {
  if (launchers.ready || launchers.loading) return Promise.resolve()
  return launchers.load().catch(() => {})
}

function openCreate() {
  closeContextMenu()
  dialogTarget.value = null
  dialogMode.value = 'create'
  draft.value = emptyDraft()
  workspaceWasPrefilled.value = false
  formError.value = ''
  void ensureLaunchers().then(() => {
    if (dialogMode.value !== 'create') return
    if (!draft.value.preset) {
      const first = agentChoices.value.find((choice) => choice.available)
      if (first) draft.value.preset = first.id
    }
    prefillWorkspace()
  })
  nextTick(() => titleInputRef.value?.focus())
}

function openEdit(routine = routines.selectedRoutine) {
  if (!routine) return
  closeContextMenu()
  routines.select(routine.id)
  dialogTarget.value = routine
  dialogMode.value = 'edit'
  draft.value = definitionDraft(routine)
  workspaceWasPrefilled.value = false
  formError.value = ''
  void ensureLaunchers().then(() => {
    if (dialogMode.value === 'edit') prefillWorkspace()
  })
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
    title: `${routine.title} copy`,
    enabled: false,
  }
  formError.value = ''
  nextTick(() => {
    titleInputRef.value?.focus()
    titleInputRef.value?.select()
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
  if (submitDisabled.value) return
  formError.value = validateDraft(draft.value, dialogMode.value)
  if (formError.value) return
  dialogBusy.value = true
  try {
    if (dialogMode.value === 'create') {
      await routines.create(buildDefinition(uniqueIdFor(draft.value.title)))
      notice.value = `${draft.value.title.trim()} created`
    } else if (dialogMode.value === 'edit') {
      await routines.update(dialogTarget.value.id, buildDefinition(dialogTarget.value.id))
      notice.value = `${draft.value.title.trim()} saved`
    } else {
      await routines.duplicate(
        dialogTarget.value.id,
        uniqueIdFor(draft.value.title),
        draft.value.title.trim(),
      )
      notice.value = `${draft.value.title.trim()} created paused`
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

function toggleDay(key) {
  const days = draft.value.scheduleState.days
  draft.value.scheduleState.days = days.includes(key)
    ? days.filter((day) => day !== key)
    : WEEKDAYS.filter((day) => day.key === key || days.includes(day.key)).map((day) => day.key)
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
  if (!routine.schedule) return { kind: 'ready', label: 'Manual' }
  if (!routine.enabled) return { kind: 'paused', label: 'Paused' }
  return { kind: 'ready', label: 'Armed' }
}

function scheduleLabel(routine) {
  return describeSchedule(routine.schedule)
}

function foreignTimezone(routine) {
  if (!routine.schedule) return false
  const timezone = routine.timezone || 'local'
  return timezone !== 'local' && timezone !== systemTimezone()
}

function nextFireLabel(routine) {
  if (!routine.schedule) return 'Manual'
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

function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function timezoneLabel(timezone) {
  if (!timezone || timezone === 'local') return systemTimezone()
  return timezone
}

function emptyDraft() {
  return {
    title: '',
    enabled: true,
    scheduled: false,
    // A live session you can talk to is the default; headless one-shot
    // reporting is the deliberate choice.
    interactive: true,
    scheduleState: defaultScheduleState(),
    timezone: systemTimezone(),
    preset: '',
    prompt: '',
    overlap: 'skip',
    missed: 'run-once',
    workspace: '',
  }
}

function definitionDraft(routine) {
  return {
    title: routine.title,
    enabled: routine.enabled,
    scheduled: Boolean(routine.schedule),
    interactive: Boolean(routine.interactive),
    scheduleState: parseSchedule(routine.schedule || ''),
    timezone: routine.timezone,
    preset: routine.preset,
    prompt: routine.prompt,
    overlap: routine.overlap,
    missed: routine.missed,
    workspace: routine.workspace || '',
  }
}

function buildDefinition(id) {
  const value = draft.value
  return {
    id,
    title: value.title.trim(),
    // Armed only means something on a schedule; the runtime ignores it for
    // manual routines, so a hand-written value is preserved, not rewritten.
    enabled: value.enabled,
    schedule: value.scheduled ? compileSchedule(value.scheduleState).cron : null,
    timezone: value.timezone,
    preset: value.preset,
    prompt: value.prompt,
    overlap: value.overlap,
    missed: value.missed,
    workspace: value.workspace,
    interactive: value.interactive,
  }
}

function validateDraft(value, mode) {
  if (!value.title?.trim()) return 'Title is required.'
  if (mode === 'duplicate') return ''
  if (!value.preset?.trim()) return 'Choose an agent to run this routine.'
  if (!value.prompt?.trim()) return 'Prompt is required.'
  if (!value.interactive && selectedAgent.value?.agentId === 'gemini') {
    return 'Gemini has no headless adapter — set Session to Interactive.'
  }
  if (workspaceRequired.value && !value.workspace?.trim()) {
    return `Pick a workspace folder — ${selectedAgent.value?.title || 'this launcher'} runs inside one.`
  }
  if (value.scheduled) {
    const { error } = compileSchedule(value.scheduleState)
    if (error) return error
  }
  return ''
}

function uniqueIdFor(title) {
  const base = slug(title) || 'routine'
  const taken = (id) => routines.routines.some((routine) => routine.id === id)
  if (!taken(base)) return base
  for (let index = 2; ; index += 1) {
    // Trim the base, not the suffix: truncating the combined string back to
    // 64 chars would repeat the same candidate forever on long titles.
    const suffix = `-${index}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!taken(candidate)) return candidate
  }
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
