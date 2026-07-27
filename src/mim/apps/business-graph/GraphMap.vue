<template>
  <div data-graph-map class="graph-map">
    <svg
      ref="svg"
      class="graph-map-canvas"
      :viewBox="viewBox"
      role="group"
      aria-label="Interactive relationship map"
      @wheel.prevent="zoomWheel"
      @pointerdown="panStart"
      @pointermove="panMove"
      @pointerup="panEnd"
      @pointercancel="panEnd"
    >
      <defs>
        <pattern id="graph-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" class="fill-[var(--color-rule-light)]" />
        </pattern>
        <marker
          id="graph-arrow"
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,7 L7,3.5 z" class="fill-[var(--color-rule)]" />
        </marker>
      </defs>

      <rect width="1600" height="1000" fill="url(#graph-dots)" />

      <g class="graph-lanes">
        <g v-for="lane in lanes" :key="lane.group">
          <rect
            :x="lane.x"
            y="62"
            width="236"
            :height="Math.max(560, lane.height)"
            rx="2"
            class="graph-lane-surface"
          />
          <text :x="lane.x + 16" y="88" class="graph-lane-title">
            {{ lane.label }}
          </text>
          <text :x="lane.x + 216" y="88" text-anchor="end" class="graph-lane-count">
            {{ lane.count }}
          </text>
        </g>
      </g>

      <g class="graph-edges">
        <path
          v-for="edge in edges"
          :key="edge.key"
          :d="edgePath(edge)"
          fill="none"
          :class="{ 'graph-edge-active': edgeActive(edge) }"
          marker-end="url(#graph-arrow)"
        >
          <title>{{ human(edge.relation) }}</title>
        </path>
        <g
          v-for="edge in activeEdges"
          :key="`label:${edge.key}`"
          :transform="`translate(${edgeLabel(edge).x} ${edgeLabel(edge).y})`"
          class="graph-edge-label"
        >
          <rect
            :x="-edgeLabel(edge).width / 2"
            y="-10"
            :width="edgeLabel(edge).width"
            height="20"
            rx="2"
          />
          <text text-anchor="middle" y="3">{{ human(edge.relation) }}</text>
        </g>
      </g>

      <g
        v-for="position in positions"
        :key="position.node.id"
        :data-map-node="position.node.id"
        :data-graph-control="`map-open-${position.node.id}`"
        class="graph-map-node"
        :class="{ 'graph-map-node-active': hovered === position.node.id }"
        tabindex="0"
        role="button"
        :aria-label="`${position.node.kind}: ${position.node.title}`"
        :transform="`translate(${position.x - 98} ${position.y - 27})`"
        @mouseenter="hovered = position.node.id"
        @mouseleave="hovered = ''"
        @focus="hovered = position.node.id"
        @blur="hovered = ''"
        @click.stop="$emit('open', position.node.id)"
        @keydown.enter.prevent="$emit('open', position.node.id)"
        @keydown.space.prevent="$emit('open', position.node.id)"
      >
        <rect width="196" height="54" rx="2" class="graph-node-surface" />
        <text x="11" y="18" class="graph-node-kind">{{ human(position.node.kind) }}</text>
        <text x="11" y="37" class="graph-node-title">
          {{ truncate(position.node.title || position.node.id, 28) }}
        </text>
        <g v-if="position.node.status" transform="translate(185 16)">
          <circle r="4" :class="statusFill(position.node.status)" />
        </g>
      </g>
    </svg>

    <div class="graph-map-purpose">
      <span>Relationship view</span>
      <strong>{{ purpose }}</strong>
      <small>Focus or hover an object to read its visible edges</small>
    </div>

    <div class="graph-map-controls" aria-label="Map controls">
      <button
        type="button"
        data-map-zoom-in
        data-graph-control="map-zoom-in"
        title="Zoom in"
        aria-label="Zoom in"
        @click="zoomBy(0.82)"
      >
        <IconPlus :size="14" />
      </button>
      <button
        type="button"
        data-map-reset
        data-graph-control="map-reset"
        title="Reset map"
        aria-label="Reset map"
        @click="reset"
      >
        <IconFocusCentered :size="14" />
      </button>
      <button
        type="button"
        data-map-zoom-out
        data-graph-control="map-zoom-out"
        title="Zoom out"
        aria-label="Zoom out"
        @click="zoomBy(1.22)"
      >
        <IconMinus :size="14" />
      </button>
    </div>

    <div class="graph-map-status">
      <span>{{ positions.length }} objects</span>
      <span>{{ edges.length }} relationships</span>
      <span>Scroll to zoom · drag to pan</span>
    </div>

    <div v-if="!positions.length" class="graph-map-empty">
      <h2>No visible relationships</h2>
      <p>Choose another scope or create a relation from an object.</p>
      <button
        type="button"
        data-graph-control="map-empty-create"
        @click="$emit('create')"
      >
        Create an item
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconFocusCentered,
  IconMinus,
  IconPlus,
} from '@tabler/icons-vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  purpose: { type: String, default: 'Relationship overview' },
})

defineEmits(['open', 'create'])
const svg = ref(null)
const hovered = ref('')
const viewport = ref({ x: 0, y: 0, width: 1200, height: 700 })
let panning = null

const layout = computed(() => layoutNodes(props.nodes))
const positions = computed(() => layout.value.positions)
const lanes = computed(() => layout.value.lanes)
const byId = computed(() => new Map(positions.value.map(item => [item.node.id, item])))
const edges = computed(() => positions.value.flatMap(source => (
  (source.node.relations || [])
    .map(relation => {
      const target = byId.value.get(relation.target)
      return target
        ? {
            key: `${source.node.id}:${relation.relation}:${relation.target}`,
            source,
            target,
            relation: relation.relation,
          }
        : null
    })
    .filter(Boolean)
)))
const activeEdges = computed(() => (
  hovered.value
    ? edges.value.filter(edge => (
        edge.source.node.id === hovered.value || edge.target.node.id === hovered.value
      ))
    : []
))
const viewBox = computed(() => {
  const box = viewport.value
  return `${box.x} ${box.y} ${box.width} ${box.height}`
})

function layoutNodes(nodes) {
  const grouped = new Map()
  for (const node of nodes.slice(0, 100)) {
    const group = groupFor(node.kind)
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group).push(node)
  }
  const definitions = [
    { id: 'business', label: 'Business' },
    { id: 'project', label: 'Projects' },
    { id: 'work', label: 'Work' },
    { id: 'knowledge', label: 'Knowledge' },
  ].filter(definition => grouped.get(definition.id)?.length)
  const contentWidth = Math.max(236, definitions.length * 270)
  const startX = Math.max(42, (1200 - contentWidth) / 2)
  const positions = []
  const lanes = definitions.map((definition, column) => {
    const items = [...(grouped.get(definition.id) || [])].sort((left, right) => (
      degree(right) - degree(left)
      || String(left.title || left.id).localeCompare(String(right.title || right.id))
    ))
    const x = startX + column * 270
    items.forEach((node, row) => {
      positions.push({
        node,
        group: definition.id,
        x: x + 118,
        y: 132 + row * 76,
      })
    })
    return {
      group: definition.id,
      label: definition.label,
      count: items.length,
      x,
      height: Math.max(560, 104 + items.length * 76),
    }
  })
  return { positions, lanes }
}

function degree(node) {
  return (node.relations || []).length
}

function groupFor(kind) {
  if (['person', 'company'].includes(kind)) return 'business'
  if (kind === 'project') return 'project'
  if (kind === 'issue') return 'work'
  return 'knowledge'
}

function edgePath(edge) {
  const horizontal = edge.source.group !== edge.target.group
  if (horizontal) {
    const direction = edge.target.x >= edge.source.x ? 1 : -1
    const startX = edge.source.x + direction * 98
    const endX = edge.target.x - direction * 102
    const control = Math.max(35, Math.abs(endX - startX) * 0.45)
    return [
      `M ${startX} ${edge.source.y}`,
      `C ${startX + direction * control} ${edge.source.y},`,
      `${endX - direction * control} ${edge.target.y},`,
      `${endX} ${edge.target.y}`,
    ].join(' ')
  }
  const side = edge.target.y >= edge.source.y ? 1 : -1
  return [
    `M ${edge.source.x + 74} ${edge.source.y + side * 27}`,
    `C ${edge.source.x + 125} ${edge.source.y + side * 42},`,
    `${edge.target.x + 125} ${edge.target.y - side * 42},`,
    `${edge.target.x + 74} ${edge.target.y - side * 27}`,
  ].join(' ')
}

function edgeLabel(edge) {
  const label = human(edge.relation)
  return {
    x: (edge.source.x + edge.target.x) / 2,
    y: (edge.source.y + edge.target.y) / 2,
    width: Math.max(54, label.length * 6.2 + 18),
  }
}

function edgeActive(edge) {
  return hovered.value
    && (edge.source.node.id === hovered.value || edge.target.node.id === hovered.value)
}

function statusFill(status) {
  if (status === 'in-progress') return 'fill-[var(--color-accent)]'
  if (status === 'waiting') return 'fill-[var(--color-rem)]'
  if (status === 'done') return 'fill-[var(--color-add)]'
  return 'fill-[var(--color-ink-4)]'
}

function zoomWheel(event) {
  zoomAt(event.deltaY > 0 ? 1.12 : 0.89, event.offsetX, event.offsetY)
}

function zoomBy(factor) {
  zoomAt(factor, 600, 350)
}

function zoomAt(factor, px, py) {
  const box = viewport.value
  const nextWidth = Math.min(2200, Math.max(420, box.width * factor))
  const nextHeight = nextWidth * (700 / 1200)
  const ratioX = px / Math.max(svg.value?.clientWidth || 1200, 1)
  const ratioY = py / Math.max(svg.value?.clientHeight || 700, 1)
  viewport.value = {
    x: box.x + (box.width - nextWidth) * ratioX,
    y: box.y + (box.height - nextHeight) * ratioY,
    width: nextWidth,
    height: nextHeight,
  }
}

function panStart(event) {
  if (event.button !== 0 || event.target.closest?.('[data-map-node]')) return
  event.currentTarget.setPointerCapture(event.pointerId)
  panning = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    viewport: { ...viewport.value },
  }
}

function panMove(event) {
  if (!panning || panning.pointerId !== event.pointerId) return
  const scaleX = panning.viewport.width / Math.max(svg.value?.clientWidth || 1200, 1)
  const scaleY = panning.viewport.height / Math.max(svg.value?.clientHeight || 700, 1)
  viewport.value = {
    ...panning.viewport,
    x: panning.viewport.x - (event.clientX - panning.x) * scaleX,
    y: panning.viewport.y - (event.clientY - panning.y) * scaleY,
  }
}

function panEnd(event) {
  if (panning?.pointerId === event.pointerId) panning = null
}

function reset() {
  viewport.value = { x: 0, y: 0, width: 1200, height: 700 }
}

function truncate(value, max) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function human(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}
</script>

<style scoped>
.graph-map {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background: var(--color-chrome-high);
}

.graph-map-canvas {
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.graph-map-canvas:active {
  cursor: grabbing;
}

.graph-lane-surface {
  fill: color-mix(in srgb, var(--color-surface) 56%, transparent);
  stroke: var(--color-rule-light);
}

.graph-lane-title {
  fill: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.graph-lane-count {
  fill: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.graph-edges path {
  stroke: color-mix(in srgb, var(--color-rule) 82%, transparent);
  stroke-width: 1.15;
}

.graph-edges:has(.graph-edge-active) path:not(.graph-edge-active) {
  opacity: 0.2;
}

.graph-edges .graph-edge-active {
  stroke: var(--color-accent);
  stroke-width: 1.6;
  opacity: 1;
}

.graph-edge-label rect {
  fill: var(--color-surface);
  stroke: color-mix(in srgb, var(--color-accent) 32%, var(--color-rule));
}

.graph-edge-label text {
  fill: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 600;
}

.graph-map-node {
  cursor: pointer;
  outline: none;
}

.graph-node-surface {
  fill: var(--color-surface);
  stroke: var(--color-rule);
}

.graph-map-node:hover .graph-node-surface,
.graph-map-node:focus .graph-node-surface,
.graph-map-node-active .graph-node-surface {
  stroke: var(--color-accent);
}

.graph-node-kind {
  fill: var(--color-ink-4);
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 620;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.graph-node-title {
  fill: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 630;
}

.graph-map-purpose {
  position: absolute;
  top: 14px;
  left: 14px;
  max-width: min(360px, calc(100% - 120px));
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 10px 12px;
}

.graph-map-purpose span,
.graph-map-purpose strong,
.graph-map-purpose small {
  display: block;
}

.graph-map-purpose span {
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.graph-map-purpose strong {
  margin-top: 4px;
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 650;
}

.graph-map-purpose small {
  margin-top: 3px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.graph-map-controls {
  position: absolute;
  top: 14px;
  right: 14px;
  display: flex;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
}

.graph-map-controls button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-right: 1px solid var(--color-rule-light);
  color: var(--color-ink-3);
}

.graph-map-controls button:last-child {
  border-right: 0;
}

.graph-map-controls button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-map-controls button:focus-visible {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: -2px;
}

.graph-map-status {
  position: absolute;
  bottom: 13px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 6px 9px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.graph-map-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  text-align: center;
}

.graph-map-empty h2 {
  margin-top: 12px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.graph-map-empty p {
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
}

.graph-map-empty > button {
  min-height: 34px;
  margin-top: 16px;
  border: 1px solid var(--color-rule);
  border-radius: 5px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
}

.graph-map-empty > button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 540px) {
  .graph-map-purpose small,
  .graph-map-status span:last-child {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .graph-edges path,
  .graph-node-surface {
    transition: none;
  }
}
</style>
