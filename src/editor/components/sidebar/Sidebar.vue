<template>
    <div
        class="sidebar-shell shrink-0 overflow-hidden"
        :class="dragging ? 'sidebar-shell-dragging' : ''"
        :style="{
            width: (collapsed ? 0 : width) + 'px',
            flex: '0 0 ' + (collapsed ? 0 : width) + 'px',
        }"
    >
        <div
            class="sidebar-panel h-full flex flex-col min-w-0 relative font-sans overflow-hidden bg-chrome"
            :style="{ width: width + 'px' }"
        >
            <!-- Header: uniform tab buttons, labels shown when sidebar wide enough -->
            <div class="sidebar-header">
                <button
                    v-for="item in panelItems"
                    :key="item.id"
                    class="sidebar-tab"
                    :class="{
                        'is-active': ui.activePanel === item.id && ui.panelOpen,
                    }"
                    :title="item.label"
                    @click="ui.selectPanel(item.id)"
                >
                    <component :is="item.icon" :size="15" />
                    <span v-if="showLabels" class="sidebar-tab-label">{{
                        item.label
                    }}</span>
                </button>
            </div>

            <!-- Content body -->
            <div class="flex-1 min-h-0 bg-chrome overflow-hidden flex flex-col">
                <SidebarOutline
                    v-show="ui.activePanel === 'outline'"
                    :outline="outline"
                    :cursorLine="cursorLine"
                    @scroll-to-pos="$emit('scroll-to-pos', $event)"
                />
                <SidebarNotes v-show="ui.activePanel === 'notes'" />
                <SidebarRefs
                    v-show="ui.activePanel === 'refs'"
                    :references="references"
                    @reload-refs="$emit('reload-refs')"
                />
                <SidebarHistory v-show="ui.activePanel === 'history'" />
            </div>

            <!-- Footer spacer (matches editor footer height) — notes panel has its own footer -->
            <div
                v-if="ui.activePanel !== 'notes'"
                class="h-[26px] shrink-0"
            ></div>

            <!-- Resize handle (left edge) -->
            <div
                class="resize-handle absolute top-0 -left-[6px] w-4 h-full cursor-col-resize z-[5]"
                :class="dragging ? 'resize-dragging' : ''"
                @pointerdown="onPointerDown"
            ></div>
        </div>
    </div>
</template>

<script setup>
import { computed, watch } from "vue";
import {
    IconList,
    IconMessage,
    IconBook,
    IconHistory,
} from "@tabler/icons-vue";
import SidebarOutline from "./SidebarOutline.vue";
import SidebarNotes from "./SidebarNotes.vue";
import SidebarRefs from "./SidebarRefs.vue";
import SidebarHistory from "./SidebarHistory.vue";
import { useEditorUIStore } from "../../../stores/editorUI.js";

const ui = useEditorUIStore();

const allPanelItems = [
    { id: "outline", label: "Outline", icon: IconList },
    { id: "notes", label: "Notes", icon: IconMessage },
    { id: "refs", label: "Refs", icon: IconBook },
    { id: "history", label: "History", icon: IconHistory },
];

const panelItems = computed(() =>
    ui.historyAvailable
        ? allPanelItems
        : allPanelItems.filter((p) => p.id !== "history"),
);

const props = defineProps({
    collapsed: { type: Boolean, default: false },
    width: { type: Number, default: 240 },
    dragging: { type: Boolean, default: false },
    outline: { type: Array, default: () => [] },
    references: { type: Array, default: () => [] },
    cursorLine: { type: Number, default: 0 },
});
const emit = defineEmits(["resize-start", "reload-refs", "scroll-to-pos"]);
function onPointerDown(e) {
    emit("resize-start", e);
}

const showLabels = computed(() => props.width >= 280);

watch(
    () => ui.historyAvailable,
    (available) => {
        if (!available && ui.activePanel === "history") {
            ui.activePanel = "outline";
        }
    },
);
</script>

<style scoped>
.sidebar-shell {
    transition:
        width 140ms cubic-bezier(0.4, 0, 0.2, 1),
        flex-basis 140ms cubic-bezier(0.4, 0, 0.2, 1);
}
.sidebar-shell-dragging {
    transition: none;
}

.sidebar-header {
    height: 30px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
}

.sidebar-tab {
    height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    border-radius: 4px;
    color: var(--color-ink-3);
    background: transparent;
    flex-shrink: 0;
    border: none;
    transition:
        color 100ms,
        background 100ms;
}

.sidebar-tab:hover {
    color: var(--color-ink-2);
    background: var(--color-chrome-mid);
}

.sidebar-tab.is-active {
    color: var(--color-accent);
    background: var(--color-accent-soft);
}

.sidebar-tab-label {
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 620;
    letter-spacing: 0.2px;
    white-space: nowrap;
}

.resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    right: 9px;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background 150ms;
}
.resize-handle:hover::after,
.resize-handle.resize-dragging::after {
    background: var(--color-accent);
}
</style>
