<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-graph-confirm-dialog
      class="confirm-overlay"
      @click.self="close"
    >
      <section
        ref="dialog"
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="graph-confirm-title"
        aria-describedby="graph-confirm-copy"
        @keydown.esc.prevent.stop="close"
        @keydown.tab="trapFocus"
      >
        <header class="confirm-header">
          <span class="confirm-signal" aria-hidden="true">
            <IconTrash :size="17" />
          </span>
          <div>
            <span>Recoverable action</span>
            <h2 id="graph-confirm-title">{{ title }}</h2>
          </div>
          <button
            ref="closeButton"
            type="button"
            data-graph-control="confirm-close"
            aria-label="Close confirmation"
            :disabled="busy"
            @click="close"
          >
            <IconX :size="16" />
          </button>
        </header>

        <div class="confirm-body">
          <p id="graph-confirm-copy">{{ copy }}</p>
          <div class="confirm-recovery">
            <IconHistory :size="15" />
            <span>You can undo this immediately from the graph status bar.</span>
          </div>
          <div v-if="error" data-graph-confirm-error role="alert" class="confirm-error">
            <IconAlertTriangle :size="15" />
            <span>{{ error }}</span>
          </div>
        </div>

        <footer class="confirm-footer">
          <button
            type="button"
            data-graph-control="confirm-cancel"
            class="confirm-cancel"
            :disabled="busy"
            @click="close"
          >
            Keep object
          </button>
          <button
            type="button"
            data-graph-control="confirm-submit"
            class="confirm-submit"
            :disabled="busy"
            @click="$emit('confirm')"
          >
            <IconTrash :size="14" />
            {{ busy ? 'Moving…' : confirmLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconHistory,
  IconTrash,
  IconX,
} from '@tabler/icons-vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: 'Move this object to Trash?' },
  copy: { type: String, default: 'This removes the object from the active graph.' },
  confirmLabel: { type: String, default: 'Move to Trash' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['close', 'confirm'])
const dialog = ref(null)
const closeButton = ref(null)
let restoreFocusTo = null

watch(
  () => props.open,
  async open => {
    if (!open) {
      const target = restoreFocusTo
      restoreFocusTo = null
      await nextTick()
      if (target?.isConnected) target.focus()
      return
    }
    restoreFocusTo = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    await nextTick()
    closeButton.value?.focus()
  },
  { immediate: true },
)

function close() {
  if (!props.busy) emit('close')
}

function trapFocus(event) {
  const focusable = [...(dialog.value?.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  z-index: 160;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-ink) 36%, transparent);
  padding: 18px;
}

.confirm-dialog {
  width: min(460px, 100%);
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--color-ink) 22%, transparent);
}

.confirm-header {
  display: flex;
  min-height: 72px;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 11px 14px 11px 18px;
}

.confirm-signal {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-rem) 9%, var(--color-surface));
  color: var(--color-rem);
}

.confirm-header > div {
  min-width: 0;
  flex: 1 1 auto;
}

.confirm-header > div > span {
  display: block;
  color: var(--color-rem);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.confirm-header h2 {
  margin-top: 4px;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 680;
  line-height: 1.3;
}

.confirm-header > button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.confirm-header > button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.confirm-header > button:focus-visible,
.confirm-cancel:focus-visible,
.confirm-submit:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 1px;
}

.confirm-body {
  padding: 20px;
}

.confirm-body > p {
  color: var(--color-ink-2);
  font-size: 13px;
  line-height: 1.55;
}

.confirm-recovery {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  border-radius: 2px;
  background: var(--color-chrome-high);
  padding: 10px 11px;
  color: var(--color-ink-4);
  font-size: 10px;
  line-height: 1.45;
}

.confirm-recovery svg,
.confirm-error svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.confirm-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  border: 1px solid color-mix(in srgb, var(--color-rem) 24%, var(--color-rule));
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-rem) 5%, var(--color-surface));
  padding: 10px 11px;
  color: var(--color-rem);
  font-size: 10px;
  line-height: 1.45;
}

.confirm-footer {
  display: flex;
  min-height: 59px;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 9px 14px;
}

.confirm-cancel,
.confirm-submit {
  min-height: 35px;
  border-radius: 5px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 650;
}

.confirm-cancel {
  color: var(--color-ink-3);
}

.confirm-cancel:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.confirm-submit {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--color-rem);
  color: white;
}

.confirm-submit:hover {
  background: color-mix(in srgb, var(--color-rem) 86%, var(--color-ink));
}

.confirm-header > button:disabled,
.confirm-cancel:disabled,
.confirm-submit:disabled {
  cursor: default;
  opacity: 0.45;
}
</style>
