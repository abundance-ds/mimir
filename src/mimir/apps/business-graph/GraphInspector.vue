<template>
  <aside
    v-if="node"
    ref="inspectorRoot"
    data-graph-inspector
    :data-inspector-mode="mode"
    class="graph-object"
    :class="mode === 'focus' ? 'graph-object-focus' : 'graph-object-peek'"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <GraphInspectorPeek v-if="mode === 'peek'" />
    <GraphInspectorFocus v-else />
  </aside>
</template>

<script setup>
import GraphInspectorFocus from './GraphInspectorFocus.vue'
import GraphInspectorPeek from './GraphInspectorPeek.vue'
import { useGraphInspector } from './useGraphInspector.js'
import './graph-inspector/inspector-shell.css'
import './graph-inspector/inspector-fields.css'
import './graph-inspector/inspector-actions.css'
import './graph-inspector/inspector-focus.css'

const props = defineProps({
  mode: {
    type: String,
    default: 'peek',
    validator: value => ['peek', 'focus'].includes(value),
  },
  node: { type: Object, default: null },
  neighbors: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  conflict: { type: Object, default: null },
  error: { type: String, default: '' },
  saving: { type: Boolean, default: false },
  activities: { type: Array, default: () => [] },
  historyBack: { type: Object, default: null },
  historyForward: { type: Object, default: null },
})

const emit = defineEmits([
  'back',
  'close',
  'focus',
  'save',
  'openNode',
  'openFile',
  'openUrl',
  'openActivity',
  'quickCreate',
  'delete',
  'navigateHistory',
  'openMeeting',
])

const { context, exposed } = useGraphInspector(props, emit)
const { mode, node, inspectorRoot, onKeydown } = context

defineExpose(exposed)
</script>
