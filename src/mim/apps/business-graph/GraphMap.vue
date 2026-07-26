<template>
  <div
    data-graph-map
    class="relative min-h-0 flex-1 overflow-hidden bg-chrome-high"
  >
    <svg
      ref="svg"
      class="size-full touch-none select-none"
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
        <marker
          id="graph-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L6,3 z" class="fill-[var(--color-rule)]" />
        </marker>
      </defs>
      <g>
        <line
          v-for="edge in edges"
          :key="edge.key"
          :x1="edge.source.x"
          :y1="edge.source.y"
          :x2="edge.target.x"
          :y2="edge.target.y"
          class="stroke-[var(--color-rule)]"
          stroke-width="1"
          marker-end="url(#graph-arrow)"
        >
          <title>{{ edge.relation.replaceAll('-', ' ') }}</title>
        </line>
      </g>
      <g
        v-for="position in positions"
        :key="position.node.id"
        :data-map-node="position.node.id"
        class="cursor-pointer outline-none"
        tabindex="0"
        role="button"
        :aria-label="`${position.node.kind}: ${position.node.title}`"
        :transform="`translate(${position.x - 58} ${position.y - 17})`"
        @click.stop="$emit('open', position.node.id)"
        @keydown.enter.prevent="$emit('open', position.node.id)"
        @keydown.space.prevent="$emit('open', position.node.id)"
      >
        <rect
          width="116"
          height="34"
          rx="2"
          class="fill-[var(--color-surface)] stroke-[var(--color-rule)] hover:stroke-[var(--color-accent)]"
        />
        <circle cx="9" cy="10" r="3" :class="kindFill(position.node.kind)" />
        <text
          x="16"
          y="12"
          class="fill-[var(--color-ink-2)] text-[7px] font-semibold"
        >{{ truncate(position.node.title || position.node.id, 22) }}</text>
        <text
          x="9"
          y="25"
          class="fill-[var(--color-ink-4)] font-mono text-[5.5px] uppercase tracking-[0.08em]"
        >{{ position.node.kind }}</text>
        <text
          v-if="position.node.status"
          x="107"
          y="25"
          text-anchor="end"
          class="fill-[var(--color-ink-4)] font-mono text-[5.5px]"
        >{{ position.node.status }}</text>
      </g>
    </svg>

    <div class="absolute right-2 top-2 flex border border-rule bg-surface shadow-sm">
      <button
        type="button"
        data-map-zoom-in
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Zoom in"
        aria-label="Zoom in"
        @click="zoomBy(0.82)"
      ><IconPlus :size="12" /></button>
      <button
        type="button"
        data-map-reset
        class="grid size-7 place-items-center border-x border-rule-light text-ink-3 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Reset map"
        aria-label="Reset map"
        @click="reset"
      ><IconFocusCentered :size="12" /></button>
      <button
        type="button"
        data-map-zoom-out
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Zoom out"
        aria-label="Zoom out"
        @click="zoomBy(1.22)"
      ><IconMinus :size="12" /></button>
    </div>

    <div class="absolute bottom-2 left-2 border border-rule bg-surface/95 px-2 py-1 font-mono text-[6px] uppercase tracking-[0.09em] text-ink-4">
      {{ positions.length }} nodes · {{ edges.length }} visible relations · scroll to zoom
    </div>

    <div v-if="!positions.length" class="absolute inset-0 grid place-items-center text-center">
      <div>
        <IconTopologyStar3 :size="22" class="mx-auto text-ink-4" />
        <p class="mt-2 text-[9px] text-ink-3">No visible relationships</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconFocusCentered,
  IconMinus,
  IconPlus,
  IconTopologyStar3,
} from '@tabler/icons-vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
})

defineEmits(['open'])
const svg = ref(null)
const viewport = ref({ x: 0, y: 0, width: 900, height: 560 })
let panning = null

const positions = computed(() => layoutNodes(props.nodes))
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
const viewBox = computed(() => {
  const box = viewport.value
  return `${box.x} ${box.y} ${box.width} ${box.height}`
})

function layoutNodes(nodes) {
  const groups = new Map()
  for (const node of nodes.slice(0, 100)) {
    const group = groupFor(node.kind)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(node)
  }
  const order = ['business', 'project', 'work', 'knowledge']
  return order.flatMap((group, column) => {
    const items = groups.get(group) || []
    const spacing = Math.max(50, 500 / Math.max(items.length, 1))
    const start = 45 + Math.max(0, (500 - spacing * (items.length - 1)) / 2)
    return items.map((node, row) => ({
      node,
      x: 105 + column * 220,
      y: start + row * spacing,
    }))
  })
}

function groupFor(kind) {
  if (['person', 'company'].includes(kind)) return 'business'
  if (kind === 'project') return 'project'
  if (kind === 'issue') return 'work'
  return 'knowledge'
}

function kindFill(kind) {
  if (kind === 'issue') return 'fill-[var(--color-accent)]'
  if (kind === 'project') return 'fill-[var(--color-add)]'
  if (['person', 'company'].includes(kind)) return 'fill-[var(--color-ink-3)]'
  return 'fill-[var(--color-ink-4)]'
}

function zoomWheel(event) {
  zoomAt(event.deltaY > 0 ? 1.12 : 0.89, event.offsetX, event.offsetY)
}

function zoomBy(factor) {
  zoomAt(factor, 450, 280)
}

function zoomAt(factor, px, py) {
  const box = viewport.value
  const nextWidth = Math.min(1800, Math.max(320, box.width * factor))
  const nextHeight = nextWidth * (560 / 900)
  const ratioX = px / Math.max(svg.value?.clientWidth || 900, 1)
  const ratioY = py / Math.max(svg.value?.clientHeight || 560, 1)
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
  const scaleX = panning.viewport.width / Math.max(svg.value?.clientWidth || 900, 1)
  const scaleY = panning.viewport.height / Math.max(svg.value?.clientHeight || 560, 1)
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
  viewport.value = { x: 0, y: 0, width: 900, height: 560 }
}

function truncate(value, max) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
</script>
