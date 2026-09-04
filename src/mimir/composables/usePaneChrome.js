import { computed, inject, onBeforeUnmount, provide, reactive, ref, toValue, watchEffect } from 'vue'

const PANE_CHROME = Symbol('pane-chrome')

/**
 * Called once by PaneFrame. Returns the element that hosts contributed
 * actions and the meta line the active surface asked for.
 */
export function providePaneChrome() {
  const actionsHost = ref(null)
  const contributions = reactive(new Map())
  const meta = computed(() => {
    for (const entry of contributions.values()) {
      if (entry.active && entry.meta) return entry.meta
    }
    return ''
  })
  provide(PANE_CHROME, { actionsHost, contributions })
  return { actionsHost, meta }
}

/**
 * Called by an Activity or app surface that wants its status line and
 * primary actions in the pane header instead of a second header of its own.
 *
 * `active` gates both, because every hosted surface stays mounted.
 * `meta` is a ref, getter, or string shown after the pane title.
 * `actionsHost` is the Teleport target, or null when the surface is not
 * inside a PaneFrame, in which case the surface renders its actions inline.
 */
export function usePaneChrome(options = {}) {
  const chrome = inject(PANE_CHROME, null)
  const isActive = () => Boolean(toValue(options.active ?? true))
  const actionsHost = computed(() => (chrome && isActive() ? chrome.actionsHost.value : null))
  if (chrome && options.meta !== undefined) {
    const key = Symbol('pane-chrome-contribution')
    watchEffect(() => {
      chrome.contributions.set(key, {
        active: isActive(),
        meta: String(toValue(options.meta) || ''),
      })
    })
    onBeforeUnmount(() => {
      chrome.contributions.delete(key)
    })
  }
  return { hosted: Boolean(chrome), actionsHost }
}
