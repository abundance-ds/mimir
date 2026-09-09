import { computed, nextTick, toValue } from 'vue'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { paneControls } from '../paneControls.js'
export function usePaneControls(pane) {
  const workbench = useWorkbenchStore()
  const controls = computed(() => paneControls(workbench.paneLayout, toValue(pane)))
  async function restore(target) {
    workbench.setPaneState(target, 'expanded')
    await nextTick()
    const selector = target === 'sidebar' ? '[data-sidebar-collapse], [data-sidebar-workspace]'
      : target === 'activity' ? '[data-pane-header="activity"] button:not(:disabled)'
      : '[data-pane="editor"] [data-editor-tabs-region] button:not(:disabled), [data-pane="editor"] button:not(:disabled)'
    document.querySelector(selector)?.focus()
  }
  async function collapse() {
    const target = toValue(pane)
    workbench.setPaneState(target, 'rail')
    await nextTick()
    document.querySelector(`[data-pane-restore="${target}"]`)?.focus()
  }
  async function expand(event) {
    const button = event.currentTarget
    if (toValue(pane) === 'activity') workbench.setActivityExpanded(!controls.value.expanded)
    else workbench.setEditorExpanded(!controls.value.expanded)
    await nextTick()
    button?.focus()
  }
  return { controls, restore, collapse, expand }
}
