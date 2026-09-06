<template>
  <div v-if="error" data-graph-error role="alert" class="graph-alert">
    <IconAlertTriangle :size="15" class="shrink-0" />
    <span>{{ error }}</span>
    <button type="button" data-graph-control="retry" @click="$emit('retry')">Retry</button>
  </div>

  <div v-if="!hasWorkspace" data-graph-no-workspace class="graph-state">
    <IconFolderOpen :size="24" :stroke-width="1.5" />
    <h2>Open a project to begin</h2>
    <p>Mimir composes local private notes with the project and shared team graph.</p>
    <button
      type="button"
      data-graph-control="choose-workspace"
      class="graph-secondary-button"
      @click="$emit('chooseWorkspace')"
    >
      Choose folder
    </button>
  </div>

  <div v-if="lastDeletion || closedIssueUndo" class="graph-toasts">
    <div v-if="closedIssueUndo" data-graph-close-undo role="status" class="graph-toast">
      <span>{{ closedIssueUndoError ? `Could not undo: ${closedIssueUndoError}` : closedIssueUndo.entries.length === 1
        ? `Closed “${closedIssueUndo.entries[0].title}”`
        : `Closed ${closedIssueUndo.entries.length} issues` }}</span>
      <button
        type="button"
        data-graph-control="undo-close-issues"
        :disabled="undoingClosedIssues"
        @click="$emit('undoClosedIssues')"
      >{{ undoingClosedIssues ? 'Restoring…' : closedIssueUndoError ? 'Retry' : 'Undo' }}</button>
      <button
        type="button"
        data-graph-control="dismiss-close-undo"
        aria-label="Dismiss closed issue notification"
        :disabled="undoingClosedIssues"
        @click="$emit('dismissClosedIssueUndo')"
      ><IconX :size="14" /></button>
    </div>
    <div v-if="lastDeletion" data-graph-undo role="status" class="graph-toast">
      <span>
        {{
          undoError
            ? `Could not restore “${lastDeletion.title}”: ${undoError}`
            : `Moved “${lastDeletion.title}” to Trash`
        }}
      </span>
      <button type="button" data-graph-control="undo-delete" @click="$emit('undo')">
        {{ undoError ? 'Retry' : 'Undo' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { IconAlertTriangle, IconFolderOpen, IconX } from '@tabler/icons-vue'

defineProps({
  error: { type: String, default: '' },
  hasWorkspace: { type: Boolean, default: false },
  lastDeletion: { type: Object, default: null },
  undoError: { type: String, default: '' },
  closedIssueUndo: { type: Object, default: null },
  closedIssueUndoError: { type: String, default: '' },
  undoingClosedIssues: { type: Boolean, default: false },
})

defineEmits(['chooseWorkspace', 'retry', 'undo', 'undoClosedIssues', 'dismissClosedIssueUndo'])
</script>

<style scoped>
.graph-alert {
  display: flex;
  min-height: 42px;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 28%, var(--color-rule));
  background: color-mix(in srgb, var(--color-rem) 5%, var(--graph-raised));
  padding: 7px 14px;
  color: var(--color-rem);
  font-size: 11px;
}

.graph-alert span {
  min-width: 0;
  flex: 1 1 auto;
}

.graph-alert button {
  min-height: 28px;
  border-radius: 4px;
  padding: 0 9px;
  font-weight: 650;
}

.graph-alert button:hover {
  background: color-mix(in srgb, var(--color-rem) 9%, transparent);
}

.graph-state {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  place-content: center;
  justify-items: center;
  padding: 40px 24px;
  text-align: center;
}

.graph-state > svg {
  color: var(--color-ink-4);
}

.graph-state h2 {
  margin-top: 15px;
  color: var(--color-ink);
  font-size: 16px;
  font-weight: 660;
  letter-spacing: -0.018em;
}

.graph-state p {
  max-width: 400px;
  margin-top: 7px;
  color: var(--color-ink-3);
  font-size: 12px;
  line-height: 1.55;
}

.graph-secondary-button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 18px;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  background: var(--graph-raised);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
}

.graph-secondary-button:hover {
  background: var(--graph-hover);
  color: var(--color-ink);
}

.graph-secondary-button:focus-visible {
  outline: 2px solid var(--graph-focus);
  outline-offset: 1px;
}

.graph-toasts {
  position: absolute;
  z-index: 110;
  bottom: 36px;
  left: 50%;
  display: grid;
  gap: 6px;
  max-width: calc(100% - 32px);
  transform: translateX(-50%);
}

.graph-toast {
  display: flex;
  min-width: 0;
  min-height: 42px;
  align-items: center;
  gap: 14px;
  border-radius: 2px;
  background: var(--color-ink);
  padding: 8px 13px;
  color: var(--color-surface);
  font-size: 11px;
  box-shadow: var(--graph-shadow);
}

.graph-toast span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-toast button {
  flex-shrink: 0;
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, white 40%, transparent);
  text-underline-offset: 3px;
}
.graph-toast button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.graph-toast button:disabled { opacity: 0.5; }
</style>
