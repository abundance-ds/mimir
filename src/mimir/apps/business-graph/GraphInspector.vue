<template>
  <section
    v-if="node"
    ref="inspectorRoot"
    data-graph-inspector
    data-inspector-mode="details"
    class="graph-object graph-object-document"
    tabindex="-1"
    @keydown="onKeydown"
    @focusin="onFocusIn"
  >
    <GraphEntryDetails />
  </section>
</template>

<script setup>
import GraphEntryDetails from './GraphEntryDetails.vue'
import { useGraphInspector } from './useGraphInspector.js'
import './graph-inspector/inspector-shell.css'
import './graph-inspector/inspector-fields.css'
import './graph-inspector/inspector-actions.css'
import './graph-inspector/inspector-focus.css'

const props = defineProps({
  documentFile: { type: Object, required: true },
  viewState: { type: Object, default: null },
  scopeIds: { type: Array, default: () => [] },
  graphRevision: { type: [Number, String], default: 0 },
  neighbors: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  error: { type: String, default: '' },
  activities: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'startWork',
  'closeRequest',
  'source',
  'draftChange',
  'save',
  'openNode',
  'openFile',
  'openUrl',
  'openActivity',
  'quickCreate',
  'delete',
  'openMeeting',
])

const { context, exposed } = useGraphInspector(props, emit)
const { node, inspectorRoot, onKeydown, onFocusIn } = context

defineExpose(exposed)
</script>
