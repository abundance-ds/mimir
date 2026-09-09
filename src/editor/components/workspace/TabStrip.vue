<template>
    <PaneTabStrip v-bind="$attrs" ref="stripEl" label="Open editor tabs" @wheel="hideTooltip()"
        :style="dragState.active ? { '--drag-tab-w': dragTabWidth + 'px' } : {}">
            <PaneTab
                v-for="(tab, i) in tabs"
                :key="tab.id"
                class="file-tab-wrap" :selected="activeTab === i" :label="tab.name"
                :class="[
                    dragState.active && dragState.fromIndex === i ? 'tab-dragging' : '',
                    dragState.dropTarget === i ? 'tab-drop-gap' : '',
                ]"
            >
              <PaneTabButton
                class="file-tab" :selected="activeTab === i"
                :class="[
                    activeTab === i ? 'tab-active' : 'tab-inactive',
                    ['review', 'git-review'].includes(tab.type) ? 'tab-review' : '',
                    tab.preview ? 'italic' : '',
                ]"
                role="tab"
                :aria-selected="activeTab === i"
                :aria-label="tab.name"
                :aria-describedby="tooltip.visible && tooltip.index === i ? 'editor-tab-tooltip' : undefined"
                :tabindex="activeTab === i ? 0 : -1"
                @mouseenter="scheduleTooltip(i, $event.currentTarget)"
                @mouseleave="hideTooltip(i)"
                @focus="showTooltip(i, $event.currentTarget)"
                @blur="hideTooltip(i)"
                @pointerdown="onPointerDown(i, $event)"
                @contextmenu.prevent.stop="openTabMenu(i, $event)"
                @keydown.left.prevent.stop="selectKeyboardTab(i, -1)"
                @keydown.right.prevent.stop="selectKeyboardTab(i, 1)"
                @keydown.home.prevent.stop="selectKeyboardTab(i, -i)"
                @keydown.end.prevent.stop="selectKeyboardTab(i, tabs.length - 1 - i)"
                @keydown.enter.prevent.stop="selectKeyboardTab(i, 0)"
                @keydown.space.prevent.stop="selectKeyboardTab(i, 0)"
              >
                <span class="tab-name flex-1 min-w-0" aria-hidden="true">
                    <span class="tab-name-leading">{{ splitTabName(tab.name).leading }}</span>
                    <span v-if="splitTabName(tab.name).trailing" class="tab-name-trailing">{{ splitTabName(tab.name).trailing }}</span>
                </span>
                <span
                    v-if="tab.dirty"
                    class="w-[5px] h-[5px] rounded-full shrink-0"
                    :class="
                        tab.saveTone === 'failed' ? 'bg-rem' : 'bg-accent'
                    "
                    :title="
                        tab.saveTone === 'failed'
                            ? 'Save failed'
                            : 'Unsaved changes'
                    "
                ></span>
              </PaneTabButton>
              <PaneTabClose :label="tab.name" @close="$emit('close-tab', i)" />
            </PaneTab>
        <template #trailing>
        <button
            class="pane-icon-button no-drag self-center"
            aria-label="New tab"
            title="New tab"
            @click="$emit('add-tab')"
        >
            <IconPlus :size="15" :stroke-width="1.8" />
        </button>
        </template>
    </PaneTabStrip>

    <Teleport to="body">
        <Transition name="tab-tooltip">
            <div
                v-if="tooltip.visible"
                id="editor-tab-tooltip"
                ref="tooltipEl"
                role="tooltip"
                class="editor-tab-tooltip"
                :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
            >
                <span class="editor-tab-tooltip-name">{{ tooltip.name }}</span>
                <span v-if="tooltip.directory" class="editor-tab-tooltip-directory">{{ tooltip.directory }}</span>
            </div>
        </Transition>
    </Teleport>

    <Teleport to="body">
        <template v-if="tabMenu.visible">
            <div
                class="tab-menu-overlay"
                @pointerdown="closeTabMenu"
                @contextmenu.prevent="closeTabMenu"
            ></div>
            <div
                ref="tabMenuEl"
                class="tab-menu"
                role="menu"
                aria-label="Tab actions"
                :style="{ left: `${tabMenu.left}px`, top: `${tabMenu.top}px` }"
                @keydown="onTabMenuKeydown"
            >
                <button
                    type="button"
                    role="menuitem"
                    class="tab-menu-item"
                    data-tab-menu-action="close"
                    @click="closeContextTab"
                >
                    <span>Close tab</span>
                    <kbd>{{ closeShortcut }}</kbd>
                </button>
                <template v-if="contextTab?.lifecycleAction">
                    <div class="tab-menu-divider"></div>
                    <button
                        type="button"
                        role="menuitem"
                        class="tab-menu-item tab-menu-danger"
                        data-tab-menu-action="discard"
                        @click="discardContextTab"
                    >
                        {{ contextTab.lifecycleAction === 'trash' ? 'Move to Trash…' : 'Discard draft…' }}
                    </button>
                </template>
            </div>
        </template>
    </Teleport>
</template>

<script setup>
import { IconPlus } from "@tabler/icons-vue";
import { computed, ref, reactive, watch, nextTick, onUnmounted } from "vue";
import { platformKind } from "../../../shared/platform.js";
import { dirname } from "../../../shared/utils/path.js";
import { splitTabName } from "../../tabPresentation.js";

import PaneTab from "../../../shared/ui/chrome/PaneTab.vue";
import PaneTabButton from "../../../shared/ui/chrome/PaneTabButton.vue";
import PaneTabClose from "../../../shared/ui/chrome/PaneTabClose.vue";
import PaneTabStrip from "../../../shared/ui/chrome/PaneTabStrip.vue";
defineOptions({ inheritAttrs: false });

const DRAG_THRESHOLD = 5;

const props = defineProps({
    tabs: { type: Array, required: true },
    activeTab: { type: Number, default: 0 },
    arrivedTabIndex: { type: Number, default: -1 },
});

const emit = defineEmits([
    "select-tab",
    "close-tab",
    "discard-tab",
    "add-tab",
    "reorder-tab",
]);

const stripEl = ref(null);

const tooltipEl = ref(null);
const tooltip = reactive({
    visible: false,
    index: -1,
    name: "",
    directory: "",
    left: 0,
    top: 0,
});
let tooltipTimer = null;
let tabMenuReturnFocus = null;
const tabMenuEl = ref(null);
const tabMenu = reactive({
    visible: false,
    index: -1,
    left: 0,
    top: 0,
});
const contextTab = computed(() => props.tabs[tabMenu.index] || null);
const closeShortcut = platformKind() === "macos" ? "⌘W" : "Ctrl+W";

const dragState = reactive({
    fromIndex: -1,
    dropTarget: -1,
    active: false,
});

let startX = 0;
let startY = 0;
let ghostEl = null;
const dragTabWidth = ref(0);
let bodyAffordanceActive = false;
let previousBodyCursor = "";
let previousBodyUserSelect = "";

function getScrollEl() {
    return stripEl.value?.scroll;
}


watch(
    () => props.activeTab,
    () => {
        nextTick(() => {
            const buttons = getTabButtons();
            const active = buttons[props.activeTab];
            if (active && getScrollEl()) {
                active.closest('.pane-tab').scrollIntoView({
                    behavior: "auto",
                    block: "nearest",
                    inline: "nearest",
                });
            }
        });
    },
);

watch(() => props.tabs.length, () => closeTabMenu({ restoreFocus: false }));

function getTabButtons() {
    if (!stripEl.value) return [];
    return Array.from(stripEl.value.$el.querySelectorAll("button.file-tab"));
}

function positionTooltip(anchor) {
    const tooltipNode = tooltipEl.value;
    if (!anchor || !tooltipNode) return;
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltipNode.getBoundingClientRect();
    const edgeGap = 8;
    const halfWidth = tooltipRect.width / 2;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    tooltip.left = Math.min(
        viewportWidth - halfWidth - edgeGap,
        Math.max(halfWidth + edgeGap, anchorRect.left + anchorRect.width / 2),
    );
    tooltip.top = anchorRect.bottom + 6;
}

function needsTooltip(tab, anchor) {
    const leading = anchor?.querySelector(".tab-name-leading");
    const clipped = Boolean(leading && leading.scrollWidth > leading.clientWidth);
    const duplicateName = props.tabs.some((candidate) => (
        candidate.id !== tab.id && candidate.name === tab.name
    ));
    return clipped || duplicateName;
}

function openTooltip(index, anchor) {
    const tab = props.tabs[index];
    if (!tab || dragState.active || !needsTooltip(tab, anchor)) return;
    tooltip.index = index;
    tooltip.name = tab.name;
    tooltip.directory = tab.path ? dirname(tab.path) : "";
    tooltip.visible = true;
    nextTick(() => positionTooltip(anchor));
}

function scheduleTooltip(index, anchor) {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => openTooltip(index, anchor), 240);
}

function showTooltip(index, anchor) {
    clearTimeout(tooltipTimer);
    openTooltip(index, anchor);
}

function hideTooltip(index) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
    if (index !== undefined && tooltip.index !== index) return;
    tooltip.visible = false;
    tooltip.index = -1;
}

function openTabMenu(index, event) {
    if (!props.tabs[index]) return;
    hideTooltip();
    cancelDrag();
    tabMenuReturnFocus = event.currentTarget;
    tabMenu.index = index;
    tabMenu.left = event.clientX;
    tabMenu.top = event.clientY;
    tabMenu.visible = true;
    nextTick(() => {
        const menu = tabMenuEl.value;
        if (!menu) return;
        const edge = 8;
        const rect = menu.getBoundingClientRect();
        tabMenu.left = Math.max(edge, Math.min(tabMenu.left, window.innerWidth - rect.width - edge));
        tabMenu.top = Math.max(edge, Math.min(tabMenu.top, window.innerHeight - rect.height - edge));
        menu.querySelector("button")?.focus();
    });
}

function closeTabMenu({ restoreFocus = true } = {}) {
    const returnFocus = tabMenuReturnFocus;
    tabMenu.visible = false;
    tabMenu.index = -1;
    tabMenuReturnFocus = null;
    if (restoreFocus) {
        nextTick(() => {
            if (returnFocus?.isConnected) returnFocus.focus();
        });
    }
}

function closeContextTab() {
    const index = tabMenu.index;
    closeTabMenu({ restoreFocus: false });
    if (index >= 0) emit("close-tab", index);
}

function discardContextTab() {
    const index = tabMenu.index;
    closeTabMenu({ restoreFocus: false });
    if (index >= 0) emit("discard-tab", index);
}

function onTabMenuKeydown(event) {
    if (event.key === "Escape") {
        event.preventDefault();
        closeTabMenu();
        return;
    }
    const items = Array.from(tabMenuEl.value?.querySelectorAll("button") || []);
    if (!items.length) return;
    if (event.key === "Tab") {
        event.preventDefault();
        closeTabMenu();
        return;
    }
    const current = Math.max(0, items.indexOf(document.activeElement));
    let next = null;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
}

/* ── Ghost ── */

function snapGhost(tabEl, targetBtn) {
    if (!ghostEl) {
        ghostEl = tabEl.closest('.pane-tab').cloneNode(true);
        ghostEl.className = "pane-tab selected pane-tab-drag-preview snapped";
        ghostEl.style.width = `${dragTabWidth.value}px`;
        ghostEl.setAttribute('aria-hidden', 'true');
        ghostEl.inert = true;
        document.body.appendChild(ghostEl);
    }
    if (!ghostEl.classList.contains("snapped")) {
        ghostEl.classList.remove("floating");
        ghostEl.classList.add("snapped");
    }
    const r = targetBtn.closest('.pane-tab').getBoundingClientRect();
    ghostEl.style.left = `${r.left - dragTabWidth.value}px`;
    ghostEl.style.top = `${r.top}px`;
}

function snapGhostAfterLast(tabEl, lastBtn) {
    if (!ghostEl) {
        ghostEl = tabEl.closest('.pane-tab').cloneNode(true);
        ghostEl.className = "pane-tab selected pane-tab-drag-preview snapped";
        ghostEl.style.width = `${dragTabWidth.value}px`;
        ghostEl.setAttribute('aria-hidden', 'true');
        ghostEl.inert = true;
        document.body.appendChild(ghostEl);
    }
    if (!ghostEl.classList.contains("snapped")) {
        ghostEl.classList.remove("floating");
        ghostEl.classList.add("snapped");
    }
    const r = lastBtn.closest('.pane-tab').getBoundingClientRect();
    ghostEl.style.left = `${r.right + 2}px`;
    ghostEl.style.top = `${r.top}px`;
}

function removeGhost() {
    if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
    }
}

/* ── Pointer handlers ── */


function onPointerDown(index, e) {
    if (e.button !== 0) return;
    hideTooltip();
    if (props.tabs[index]?.type === "review") {
        emit("select-tab", index);
        return;
    }
    cancelDrag();

    const tabEl = getTabButtons()[index];
    dragTabWidth.value = tabEl ? tabEl.closest('.pane-tab').offsetWidth : 92;
    dragState.fromIndex = index;
    dragState.dropTarget = -1;
    dragState.active = false;
    startX = e.clientX;
    startY = e.clientY;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
}

function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!dragState.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
            return;
        dragState.active = true;
        beginBodyAffordance();
    }

    const tabEl = getTabButtons()[dragState.fromIndex];
    if (!tabEl) return;

    const buttons = getTabButtons();
    let target = -1;

    for (let i = 0; i < buttons.length; i++) {
        const rect = buttons[i].closest('.pane-tab').getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (e.clientX < mid) {
            target = i;
            break;
        }
    }
    if (target === -1) target = buttons.length;

    // Always snap ghost to where the tab would land
    if (target === dragState.fromIndex || target === dragState.fromIndex + 1) {
        dragState.dropTarget = dragState.fromIndex;
    } else {
        dragState.dropTarget = target;
    }

    const snapTarget = buttons[dragState.dropTarget];
    if (snapTarget) {
        snapGhost(tabEl, snapTarget);
    } else if (buttons.length > 0) {
        snapGhostAfterLast(tabEl, buttons[buttons.length - 1]);
    }
}

function onPointerUp() {
    removeListeners();
    removeGhost();

    if (!dragState.active) {
        const idx = dragState.fromIndex;
        resetDrag();
        emit("select-tab", idx);
        return;
    }

    const from = dragState.fromIndex;

    if (dragState.dropTarget >= 0) {
        let to = dragState.dropTarget;
        if (from < to) to -= 1;
        resetDrag();
        if (from !== to) {
            emit("reorder-tab", from, to);
        }
        return;
    }

    resetDrag();
}

function onKeyDown(e) {
    if (e.key === "Escape" && dragState.fromIndex >= 0) {
        e.preventDefault();
        cancelDrag();
    }
}

function onPointerCancel() {
    cancelDrag();
}

function selectKeyboardTab(index, delta) {
    if (!props.tabs.length) return;
    const next = (index + delta + props.tabs.length) % props.tabs.length;
    emit("select-tab", next);
    nextTick(() => getTabButtons()[next]?.focus());
}

function removeListeners() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
    document.removeEventListener("keydown", onKeyDown);
}

function beginBodyAffordance() {
    if (!document.body || bodyAffordanceActive) return;
    previousBodyCursor = document.body.style.cursor;
    previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    bodyAffordanceActive = true;
}

function endBodyAffordance() {
    if (!document.body || !bodyAffordanceActive) return;
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
    bodyAffordanceActive = false;
}

function cancelDrag() {
    removeListeners();
    resetDrag();
}

function resetDrag() {
    dragState.fromIndex = -1;
    dragState.dropTarget = -1;
    dragState.active = false;
    endBodyAffordance();
    removeGhost();
}

onUnmounted(() => {
    hideTooltip();
    closeTabMenu({ restoreFocus: false });
    cancelDrag();
});
</script>

<style scoped>
.tab-name {
    display: flex;
    align-items: baseline;
    overflow: hidden;
}

.tab-name-leading {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tab-name-trailing {
    flex: 0 0 auto;
}

/* Drag states */
.tab-dragging {
    flex: 0 0 0 !important;
    width: 0 !important;
    min-width: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    opacity: 0 !important;
    pointer-events: none;
}

.tab-drop-gap {
    margin-left: var(--drag-tab-w, 80px);
}

.editor-tab-tooltip {
    position: fixed;
    z-index: 100;
    display: flex;
    max-width: min(440px, calc(100vw - 16px));
    transform: translateX(-50%);
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--color-rule);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-ink);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--color-chrome) 45%, transparent);
    pointer-events: none;
}

.editor-tab-tooltip-name,
.editor-tab-tooltip-directory {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.editor-tab-tooltip-name {
    font-family: var(--font-mono);
    font-size: 11px;
}

.editor-tab-tooltip-directory {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: 9px;
}

.tab-tooltip-enter-active,
.tab-tooltip-leave-active {
    transition: opacity 90ms ease, transform 90ms ease;
}

.tab-tooltip-enter-from,
.tab-tooltip-leave-to {
    opacity: 0;
    transform: translate(-50%, -2px);
}

.tab-menu-overlay {
    position: fixed;
    inset: 0;
    z-index: 209;
}

.tab-menu {
    position: fixed;
    z-index: 210;
    min-width: 184px;
    padding: 4px;
    border: 1px solid var(--color-rule);
    border-radius: 6px;
    background: var(--color-surface);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}

.tab-menu-item {
    display: flex;
    width: 100%;
    min-height: 28px;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 5px 8px;
    border-radius: 4px;
    color: var(--color-ink-2);
    font-family: var(--font-sans);
    font-size: 12px;
    text-align: left;
}

.tab-menu-item:hover,
.tab-menu-item:focus-visible {
    background: var(--color-accent-soft);
    color: var(--color-ink);
    outline: none;
}

.tab-menu-item kbd {
    color: var(--color-ink-3);
    font-family: var(--font-mono);
    font-size: 10px;
}

.tab-menu-divider {
    height: 1px;
    margin: 4px;
    background: var(--color-rule-light);
}

.tab-menu-danger:hover,
.tab-menu-danger:focus-visible {
    color: var(--color-rem);
}

@media (prefers-reduced-motion: reduce) {
    .tab-tooltip-enter-active,
    .tab-tooltip-leave-active {
        transition: none;
    }
}
</style>
